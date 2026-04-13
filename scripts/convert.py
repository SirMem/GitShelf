#!/usr/bin/env python3
"""PDF to Book conversion pipeline.

Usage: python scripts/convert.py [--input-dir INPUT] [--output-dir OUTPUT]
"""

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover - handled at runtime for local tests
    fitz = None

try:
    from .mineru_client import MineruClient, extract_zip_contents
    from .split_markdown import split_by_headings
    from .generate_structure import generate_book_structure
    from .build_manifest import build_manifest
except ImportError:
    from mineru_client import MineruClient, extract_zip_contents
    from split_markdown import split_by_headings
    from generate_structure import generate_book_structure
    from build_manifest import build_manifest

try:
    from .fix_heading_levels import extract_toc, fix_heading_levels, TocEntry
except ImportError:
    from fix_heading_levels import extract_toc, fix_heading_levels, TocEntry

try:
    from .localize_images import localize_images
except ImportError:
    from localize_images import localize_images

MAX_PAGES_PER_CHUNK = 500
PAGE_THRESHOLD = 600
BOOK_METADATA_FILENAME = "meta.json"
CACHE_DIR = Path("cache/markdown")
FAILURES_FILENAME = "failures.json"
CHAPTER_IMAGES_PREFIX = "../images/"
CONTENT_DIR_NAMES = {
    "book": "books",
    "doc": "articles",
    "site": "sites",
}
CONTENT_ID_SUFFIXES = {
    "book": "book",
    "doc": "doc",
    "site": "site",
}


def _pdf_md5(pdf_path: Path) -> str:
    """Compute MD5 hex digest of a PDF file."""
    h = hashlib.md5()
    with open(pdf_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def detect_new_pdfs(input_dir: Path) -> list[Path]:
    """Find .pdf files in input_dir."""
    return sorted(input_dir.glob("*.pdf"))


def get_page_count(pdf_path: Path) -> int:
    """Get page count using PyMuPDF."""
    if fitz is None:
        raise RuntimeError(
            "PyMuPDF (fitz) is required to read PDF pages. Install dependencies from requirements.txt."
        )
    with fitz.open(pdf_path) as doc:
        return len(doc)


def split_pdf(pdf_path: Path, chunk_size: int = MAX_PAGES_PER_CHUNK) -> list[Path]:
    """Split large PDF into chunks using PyMuPDF. Returns list of chunk paths.

    Chunks are written to a temporary directory. The caller is responsible
    for cleaning up via the parent directory of the returned paths.
    """
    if fitz is None:
        raise RuntimeError(
            "PyMuPDF (fitz) is required to split PDFs. Install dependencies from requirements.txt."
        )
    tmp_dir = Path(tempfile.mkdtemp(prefix="pdf2book_chunks_"))
    chunk_paths: list[Path] = []

    with fitz.open(pdf_path) as doc:
        total = len(doc)
        for start in range(0, total, chunk_size):
            end = min(start + chunk_size, total)
            chunk_doc = fitz.open()
            chunk_doc.insert_pdf(doc, from_page=start, to_page=end - 1)
            chunk_path = tmp_dir / f"{pdf_path.stem}_chunk_{start:05d}.pdf"
            chunk_doc.save(str(chunk_path))
            chunk_doc.close()
            chunk_paths.append(chunk_path)

    return chunk_paths


def generate_book_id(pdf_path: Path) -> str:
    """Generate a stable, URL-safe content ID from a filename."""
    name = unicodedata.normalize("NFKC", pdf_path.stem).strip().lower()
    slug = re.sub(r"[\s_]+", "-", name)
    slug = re.sub(r"[^\w-]+", "-", slug, flags=re.UNICODE)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    if slug:
        return slug

    digest = hashlib.sha1(pdf_path.stem.encode("utf-8")).hexdigest()[:8]
    return f"item-{digest}"


def _content_id_conflicts(
    item_id: str,
    docs_root: Path,
    content_type: str,
    *,
    allow_same_type_existing: bool,
) -> bool:
    for known_type, directory in CONTENT_DIR_NAMES.items():
        target = docs_root / directory / item_id
        if not target.exists():
            continue
        if known_type == content_type and allow_same_type_existing:
            continue
        return True
    return False


def ensure_unique_content_id(base_id: str, docs_root: Path, content_type: str) -> str:
    """Return an ID that is unique across books, articles, and sites."""
    if not _content_id_conflicts(
        base_id,
        docs_root,
        content_type,
        allow_same_type_existing=True,
    ):
        return base_id

    suffix = CONTENT_ID_SUFFIXES.get(content_type, "item")
    candidate = f"{base_id}-{suffix}"
    index = 2
    while _content_id_conflicts(
        candidate,
        docs_root,
        content_type,
        allow_same_type_existing=False,
    ):
        candidate = f"{base_id}-{suffix}-{index}"
        index += 1
    return candidate


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write_book_metadata(
    book_dir: Path,
    *,
    book_id: str,
    source_pdf: str,
    pdf_md5: str,
    page_count: int,
    updated_at: str,
) -> None:
    created_at = updated_at
    existing_meta_path = book_dir / BOOK_METADATA_FILENAME
    if existing_meta_path.exists():
        try:
            existing = json.loads(existing_meta_path.read_text(encoding="utf-8"))
            created_at = str(existing.get("created_at", "")).strip() or created_at
        except json.JSONDecodeError:
            pass

    data = {
        "id": book_id,
        "type": "book",
        "source": source_pdf,
        "source_format": "markdown-derived",
        "pdf_md5": pdf_md5,
        "page_count": page_count,
        "created_at": created_at,
        "updated_at": updated_at,
    }
    target = book_dir / BOOK_METADATA_FILENAME
    target.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _rewrite_chapter_image_paths(markdown: str, book_id: str) -> str:
    """Normalize local image references for files stored under chapters/."""
    book_images_prefixes = (
        f"books/{book_id}/images/",
        f"./books/{book_id}/images/",
        f"../books/{book_id}/images/",
    )

    def _normalize_path(raw: str) -> str:
        value = str(raw or "").strip()
        if (
            not value
            or value.startswith(("/", "#", "//", "data:"))
            or re.match(r"^[a-z][a-z0-9+.-]*:", value, flags=re.IGNORECASE)
        ):
            return value

        if value.startswith(CHAPTER_IMAGES_PREFIX):
            return value

        for prefix in book_images_prefixes:
            if value.startswith(prefix):
                return f"{CHAPTER_IMAGES_PREFIX}{value[len(prefix):]}"

        if value.startswith("images/"):
            return f"{CHAPTER_IMAGES_PREFIX}{value[len('images/'):]}"

        if value.startswith("./images/"):
            return f"{CHAPTER_IMAGES_PREFIX}{value[len('./images/'):]}"

        return value

    markdown = re.sub(
        r"(!\[[^\]]*\]\()([^)]+)(\))",
        lambda m: f"{m.group(1)}{_normalize_path(m.group(2))}{m.group(3)}",
        markdown,
    )
    markdown = re.sub(
        r'(<img\b[^>]*\bsrc=["\'])([^"\']+)(["\'][^>]*>)',
        lambda m: f"{m.group(1)}{_normalize_path(m.group(2))}{m.group(3)}",
        markdown,
        flags=re.IGNORECASE,
    )
    return markdown


def _resolve_input_pdf(input_dir: Path, input_filename: str) -> Path:
    """Resolve a dispatch filename from input/.

    Returns the path to the PDF file.
    """
    filename = Path(input_filename).name
    if not filename:
        raise FileNotFoundError("Input filename is empty.")

    target = input_dir / filename
    if target.exists():
        return target

    raise FileNotFoundError(
        f"Specified file not found in input/: {filename}"
    )


def _find_cached_md5(output_dir: Path, source_pdf: str) -> str | None:
    """Search book metadata files for a matching source and return its MD5."""
    for meta_file in output_dir.glob(f"*/{BOOK_METADATA_FILENAME}"):
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            if meta.get("source") == source_pdf and meta.get("pdf_md5"):
                return meta["pdf_md5"]
        except (json.JSONDecodeError, KeyError):
            continue
    return None


def reconvert_from_cache(
    source_pdf: str,
    output_dir: Path,
) -> None:
    """Reconvert a book from cache when the original PDF is no longer available."""
    md5 = _find_cached_md5(output_dir, source_pdf)
    if not md5:
        raise FileNotFoundError(
            f"No cached conversion found for {source_pdf}. Re-upload the PDF."
        )

    cached = _read_cache(md5)
    if not cached:
        raise FileNotFoundError(
            f"Cache files missing for MD5 {md5}. Re-upload the PDF."
        )

    markdown, images, page_count, toc = cached
    book_id = generate_book_id(Path(source_pdf))
    title = Path(source_pdf).stem

    print(f"Reconverting from cache: {source_pdf} -> {book_id} (md5={md5})")

    # Write cached images to book directory
    images_dir = output_dir / book_id / "images"
    if images:
        images_dir.mkdir(parents=True, exist_ok=True)
        for rel_path, data in images.items():
            dest = output_dir / book_id / rel_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        print(f"  Extracted {len(images)} cached images")

    if toc:
        print(f"  Found {len(toc)} cached bookmarks, fixing heading levels...")
        markdown = fix_heading_levels(markdown, toc)

    # Download any remaining external images
    print(f"  Localizing images...")
    markdown = localize_images(markdown, images_dir, CHAPTER_IMAGES_PREFIX)
    markdown = _rewrite_chapter_image_paths(markdown, book_id)

    chapters = split_by_headings(markdown, level=1)
    generate_book_structure(book_id, title, chapters, output_dir)

    book_dir = output_dir / book_id
    _write_book_metadata(
        book_dir,
        book_id=book_id,
        source_pdf=source_pdf,
        pdf_md5=md5,
        page_count=page_count,
        updated_at=_utc_now_iso(),
    )
    print(f"  Reconversion complete.")


def _write_cache(
    md5: str,
    zip_data: bytes,
    page_count: int,
    toc: list[TocEntry],
) -> None:
    """Write raw MinerU ZIP and metadata to cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{md5}.zip").write_bytes(zip_data)
    meta = {
        "page_count": page_count,
        "toc": [{"level": e.level, "title": e.title} for e in toc],
    }
    (CACHE_DIR / f"{md5}.meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def _read_cache(md5: str) -> tuple[str, dict[str, bytes], int, list[TocEntry]] | None:
    """Read cached ZIP and metadata, extract markdown + images.

    Returns (markdown, images, page_count, toc) or None on miss.
    Also supports legacy .md-only cache (without images).
    """
    meta_file = CACHE_DIR / f"{md5}.meta.json"
    if not meta_file.exists():
        return None

    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    toc = [TocEntry(level=e["level"], title=e["title"]) for e in meta.get("toc", [])]

    zip_file = CACHE_DIR / f"{md5}.zip"
    if zip_file.exists():
        zip_data = zip_file.read_bytes()
        markdown, images = extract_zip_contents(zip_data)
        return markdown, images, meta["page_count"], toc

    # Legacy cache: .md only, no images
    md_file = CACHE_DIR / f"{md5}.md"
    if md_file.exists():
        markdown = md_file.read_text(encoding="utf-8")
        return markdown, {}, meta["page_count"], toc

    return None


def convert_single_pdf(
    pdf_path: Path,
    output_dir: Path,
    *,
    source_name: str | None = None,
) -> None:
    """Convert one PDF through the full pipeline.

    Steps:
        1. Compute MD5 and check cache
        2. If cache miss: extract page count / TOC / call MinerU API, write cache
        3. Fix heading levels using TOC
        4. Split markdown into chapters
        5. Generate book directory structure
        6. Delete the source PDF
    """
    book_id = ensure_unique_content_id(
        generate_book_id(pdf_path),
        output_dir.parent,
        "book",
    )
    title = pdf_path.stem
    source_filename = str(source_name or pdf_path.name).strip() or pdf_path.name

    print(f"Processing: {source_filename} -> {book_id}")

    md5 = _pdf_md5(pdf_path)
    cached = _read_cache(md5)

    images_dir = output_dir / book_id / "images"

    if cached:
        markdown, images, page_count, toc = cached
        print(f"  Cache hit: {md5}")
    else:
        page_count = get_page_count(pdf_path)
        print(f"  Page count: {page_count}")

        client = MineruClient()
        if page_count > PAGE_THRESHOLD:
            zip_data, markdown, images = _convert_large_pdf(client, pdf_path, page_count)
        else:
            zip_data, markdown, images = client.convert_pdf(pdf_path)

        toc = extract_toc(pdf_path)
        _write_cache(md5, zip_data, page_count, toc)
        print(f"  Cached: {md5}")

    # Write images (from ZIP or cache) to book directory
    if images:
        images_dir.mkdir(parents=True, exist_ok=True)
        for rel_path, data in images.items():
            dest = output_dir / book_id / rel_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        print(f"  Extracted {len(images)} images")

    if toc:
        print(f"  Found {len(toc)} PDF bookmarks, fixing heading levels...")
        markdown = fix_heading_levels(markdown, toc)

    # Download any remaining external images to local storage
    print(f"  Localizing images...")
    markdown = localize_images(markdown, images_dir, CHAPTER_IMAGES_PREFIX)
    markdown = _rewrite_chapter_image_paths(markdown, book_id)

    chapters = split_by_headings(markdown, level=1)
    generate_book_structure(book_id, title, chapters, output_dir)

    book_dir = output_dir / book_id
    _write_book_metadata(
        book_dir,
        book_id=book_id,
        source_pdf=source_filename,
        pdf_md5=md5,
        page_count=page_count,
        updated_at=_utc_now_iso(),
    )

    # Clear any prior failure record for this PDF
    _remove_failure(source_filename, output_dir.parent)

    # Delete source PDF — the cache preserves everything needed for reconvert
    pdf_path.unlink(missing_ok=True)
    print(f"  Deleted source: {pdf_path.name}")


def _merge_zips(zip_list: list[bytes]) -> bytes:
    """Merge multiple MinerU result ZIPs into a single ZIP."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as out:
        for i, zip_data in enumerate(zip_list):
            with zipfile.ZipFile(io.BytesIO(zip_data)) as zf:
                for name in zf.namelist():
                    if name.endswith("/"):
                        continue
                    # Prefix chunk index to markdown files to avoid collisions
                    if name.endswith(".md"):
                        out_name = f"chunk_{i:03d}/{name}"
                    else:
                        # Images can share names across chunks — keep originals
                        out_name = name
                    if out_name not in out.namelist():
                        out.writestr(out_name, zf.read(name))
    return buf.getvalue()


def _convert_large_pdf(
    client: MineruClient, pdf_path: Path, page_count: int,
) -> tuple[bytes, str, dict[str, bytes]]:
    """Split a large PDF into chunks, convert each via MinerU, and concatenate."""
    print(f"  Splitting {page_count}-page PDF into ~{MAX_PAGES_PER_CHUNK}-page chunks")
    chunk_paths = split_pdf(pdf_path)
    tmp_dir = chunk_paths[0].parent

    try:
        parts: list[str] = []
        all_images: dict[str, bytes] = {}
        all_zips: list[bytes] = []
        for i, chunk_path in enumerate(chunk_paths, 1):
            print(f"  Converting chunk {i}/{len(chunk_paths)}: {chunk_path.name}")
            zip_data, md, images = client.convert_pdf(chunk_path)
            parts.append(md)
            all_images.update(images)
            all_zips.append(zip_data)
        merged_zip = _merge_zips(all_zips)
        return merged_zip, "\n\n".join(parts), all_images
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _failures_path(docs_dir: Path) -> Path:
    return docs_dir / FAILURES_FILENAME


def _read_failures(docs_dir: Path) -> list[dict]:
    """Read existing failures.json, returning [] on missing/corrupt file."""
    path = _failures_path(docs_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("failures", [])
    except (json.JSONDecodeError, KeyError):
        return []


def _write_failures(
    new_failures: list[tuple[Path, Exception]],
    docs_dir: Path,
) -> None:
    """Persist failure records to docs/failures.json (upserts by filename)."""
    existing = {f["filename"]: f for f in _read_failures(docs_dir)}
    for pdf_path, exc in new_failures:
        existing[pdf_path.name] = {
            "filename": pdf_path.name,
            "book_id": generate_book_id(pdf_path),
            "error": str(exc),
            "failed_at": _utc_now_iso(),
        }
    docs_dir.mkdir(parents=True, exist_ok=True)
    _failures_path(docs_dir).write_text(
        json.dumps({"failures": list(existing.values())}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _remove_failure(filename: str, docs_dir: Path) -> None:
    """Remove a failure entry after successful conversion."""
    records = _read_failures(docs_dir)
    filtered = [f for f in records if f.get("filename") != filename]
    if len(filtered) == len(records):
        return  # nothing to remove
    _failures_path(docs_dir).write_text(
        json.dumps({"failures": filtered}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    """Main entry point. Parse args, run pipeline."""
    parser = argparse.ArgumentParser(description="Convert PDFs to online books.")
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=Path("input"),
        help="Path to input directory (default: input/)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("docs/books"),
        help="Path to output directory (default: docs/books)",
    )
    args = parser.parse_args()

    # If INPUT_FILENAME is set (from workflow_dispatch), filter to that file only.
    input_filename = os.environ.get("INPUT_FILENAME", "").strip()
    jobs: list[Path] = []
    if input_filename:
        try:
            jobs = [_resolve_input_pdf(args.input_dir, input_filename)]
        except FileNotFoundError:
            # PDF not in input/ — try reconvert from cache
            print(f"PDF not found, attempting reconvert from cache: {input_filename}")
            try:
                reconvert_from_cache(input_filename, args.output_dir)
                build_manifest(args.output_dir)
                print("Manifest rebuilt.")
                return
            except FileNotFoundError as exc:
                print(str(exc))
                sys.exit(1)
    else:
        jobs = detect_new_pdfs(args.input_dir)

    if not jobs:
        print("No new PDFs found in input/. Nothing to do.")
        return

    print(f"Found {len(jobs)} PDF(s) to process.")

    failures: list[tuple[Path, Exception]] = []
    for pdf_path in jobs:
        try:
            convert_single_pdf(pdf_path, args.output_dir)
        except Exception as exc:
            print(f"  FAILED: {pdf_path.name}: {exc}", file=sys.stderr)
            failures.append((pdf_path, exc))

    build_manifest(args.output_dir)
    print("Manifest rebuilt.")

    if failures:
        docs_dir = args.output_dir.parent
        _write_failures(failures, docs_dir)
        print(f"\n{len(failures)} PDF(s) failed (recorded in {FAILURES_FILENAME}):", file=sys.stderr)
        for path, exc in failures:
            print(f"  - {path.name}: {exc}", file=sys.stderr)
    else:
        print("All PDFs processed successfully.")


if __name__ == "__main__":
    main()
