#!/usr/bin/env python3
"""Unified content processing pipeline.

Handles four content types from input/:
  - .pdf  → book (chapters via MinerU API)
  - .epub → book (chapters via pandoc)
  - .md   → article (single markdown document)
  - .zip  → site (static site extraction)

Usage: python scripts/process.py [--input-dir INPUT] [--output-dir OUTPUT]
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

try:
    from .build_manifest import build_manifest
except ImportError:
    from build_manifest import build_manifest

try:
    from .split_markdown import split_by_headings
    from .generate_structure import generate_book_structure
except ImportError:
    from split_markdown import split_by_headings
    from generate_structure import generate_book_structure

# Reuse PDF pipeline from convert.py
try:
    from .convert import (
        convert_single_pdf,
        detect_new_pdfs,
        ensure_unique_content_id,
        generate_book_id,
        reconvert_from_cache,
        _rewrite_chapter_image_paths,
        _write_failures,
        _remove_failure,
    )
except ImportError:
    from convert import (
        convert_single_pdf,
        detect_new_pdfs,
        ensure_unique_content_id,
        generate_book_id,
        reconvert_from_cache,
        _rewrite_chapter_image_paths,
        _write_failures,
        _remove_failure,
    )

FAILURES_FILENAME = "failures.json"
BOOK_METADATA_FILENAME = "meta.json"
EPUB_CACHE_DIR = Path("cache/epub")


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _generate_id(path: Path) -> str:
    """Generate URL-safe ID from filename (reuses book ID logic)."""
    return generate_book_id(path)


def _file_md5(path: Path) -> str:
    """Compute MD5 hex digest for an input file."""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def detect_new_epubs(input_dir: Path) -> list[Path]:
    """Find .epub files in input_dir."""
    return sorted(input_dir.glob("*.epub"))


def _read_existing_created_at(book_dir: Path, fallback: str) -> str:
    meta_path = book_dir / BOOK_METADATA_FILENAME
    if not meta_path.exists():
        return fallback

    try:
        existing = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return fallback

    return str(existing.get("created_at", "")).strip() or fallback


def _write_epub_metadata(
    book_dir: Path,
    *,
    book_id: str,
    source_epub: str,
    epub_md5: str,
    updated_at: str,
    created_at: str | None = None,
) -> None:
    normalized_created_at = created_at or _read_existing_created_at(book_dir, updated_at)
    data = {
        "id": book_id,
        "type": "book",
        "source": source_epub,
        "source_format": "epub",
        "epub_md5": epub_md5,
        "created_at": normalized_created_at,
        "updated_at": updated_at,
    }
    (book_dir / BOOK_METADATA_FILENAME).write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _write_epub_cache(md5: str, epub_path: Path) -> None:
    EPUB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(epub_path, EPUB_CACHE_DIR / f"{md5}.epub")


def _find_cached_epub(output_dir: Path, source_epub: str) -> tuple[str, str] | None:
    """Return ``(book_id, md5)`` for a cached EPUB source."""
    for meta_file in output_dir.glob(f"*/{BOOK_METADATA_FILENAME}"):
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue

        if meta.get("source") == source_epub and meta.get("epub_md5"):
            return meta_file.parent.name, str(meta["epub_md5"])
    return None


def _sanitize_pandoc_markdown(markdown: str) -> str:
    """Remove pandoc EPUB wrapper elements that add noise to rendered chapters."""
    sanitized = re.sub(
        r"^\s*<span\b[^>]*>\s*</span>\s*$\n?",
        "",
        markdown,
        flags=re.MULTILINE,
    )
    sanitized = re.sub(
        r"^\s*<div\b[^>]*class=[\"'][^\"']*\bsection\b[^\"']*[\"'][^>]*>\s*$\n?",
        "",
        sanitized,
        flags=re.MULTILINE,
    )
    sanitized = re.sub(r"^\s*</div>\s*$\n?", "", sanitized, flags=re.MULTILINE)
    sanitized = re.sub(r"\n{3,}", "\n\n", sanitized).strip()
    return sanitized + "\n" if sanitized else ""


def _rewrite_book_asset_paths(
    markdown: str,
    source_prefixes: tuple[str, ...],
    dest_prefix: str,
) -> str:
    """Rewrite relative markdown assets from one local prefix to another."""

    def _normalize_path(raw: str) -> str:
        value = str(raw or "").strip()
        if (
            not value
            or value.startswith(("/", "#", "//", "data:"))
            or re.match(r"^[a-z][a-z0-9+.-]*:", value, flags=re.IGNORECASE)
        ):
            return value

        for prefix in source_prefixes:
            if value.startswith(prefix):
                return f"{dest_prefix}{value[len(prefix):]}"

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


def _select_chapter_level(markdown: str) -> tuple[list, int]:
    """Pick a usable heading level for book chapters, preferring multi-chapter splits."""
    fallback: tuple[list, int] | None = None
    for level in (1, 2, 3):
        try:
            chapters = split_by_headings(markdown, level=level)
        except ValueError:
            continue

        if fallback is None:
            fallback = (chapters, level)

        chapter_count = sum(1 for chapter in chapters if chapter.slug != "00-preface")
        if chapter_count >= 2:
            return chapters, level

    if fallback is None:
        raise ValueError("No headings found in EPUB-derived markdown.")

    return fallback


def _copy_epub_media(work_dir: Path, book_dir: Path) -> int:
    """Copy pandoc-extracted media into the book's images directory."""
    media_dir = work_dir / "media"
    if not media_dir.is_dir():
        return 0

    images_dir = book_dir / "images"
    copied = 0
    for source in media_dir.rglob("*"):
        if not source.is_file():
            continue
        destination = images_dir / source.relative_to(media_dir)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied += 1
    return copied


def _run_pandoc_epub(epub_path: Path, work_dir: Path) -> str:
    """Convert EPUB to Markdown using pandoc within a temporary work directory."""
    output_name = "book.md"
    command = [
        "pandoc",
        str(epub_path.resolve()),
        "-t",
        "gfm",
        "--wrap=none",
        "--extract-media=.",
        "-o",
        output_name,
    ]

    try:
        subprocess.run(
            command,
            check=True,
            cwd=work_dir,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "pandoc is required to process EPUB files. Install pandoc locally "
            "and in GitHub Actions."
        ) from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        raise RuntimeError(
            f"pandoc failed to convert {epub_path.name}: {detail[:200]}"
        ) from exc

    output_path = work_dir / output_name
    if not output_path.exists():
        raise RuntimeError(f"pandoc did not produce {output_name} for {epub_path.name}")

    return output_path.read_text(encoding="utf-8")


def _build_epub_book(epub_path: Path, output_dir: Path, book_id: str, title: str) -> int:
    """Convert an EPUB source into the standard book directory structure."""
    book_dir = output_dir / book_id
    if book_dir.exists():
        shutil.rmtree(book_dir)

    with tempfile.TemporaryDirectory(prefix="gitshelf_epub_") as tmp_dir:
        work_dir = Path(tmp_dir)
        markdown = _run_pandoc_epub(epub_path, work_dir)
        markdown = _sanitize_pandoc_markdown(markdown)
        markdown = _rewrite_book_asset_paths(
            markdown,
            source_prefixes=("media/", "./media/"),
            dest_prefix="images/",
        )
        markdown = _rewrite_chapter_image_paths(markdown, book_id)

        chapters, chapter_level = _select_chapter_level(markdown)
        generate_book_structure(
            book_id,
            title,
            chapters,
            chapter_level=chapter_level,
            output_dir=output_dir,
        )
        copied = _copy_epub_media(work_dir, book_dir)

    return copied


def process_epub(epub_path: Path, output_dir: Path) -> None:
    """Process a single .epub file into a multi-chapter book."""
    book_id = ensure_unique_content_id(_generate_id(epub_path), output_dir.parent, "book")
    title = epub_path.stem
    md5 = _file_md5(epub_path)
    book_dir = output_dir / book_id
    timestamp = _utc_now_iso()
    created_at = _read_existing_created_at(book_dir, timestamp)

    print(f"Processing EPUB: {epub_path.name} -> {book_id}")

    copied_assets = _build_epub_book(epub_path, output_dir, book_id, title)
    if copied_assets:
        print(f"  Extracted {copied_assets} EPUB assets")

    _write_epub_cache(md5, epub_path)

    _write_epub_metadata(
        book_dir,
        book_id=book_id,
        source_epub=epub_path.name,
        epub_md5=md5,
        created_at=created_at,
        updated_at=timestamp,
    )

    epub_path.unlink(missing_ok=True)
    print(f"  Deleted source: {epub_path.name}")


def reconvert_epub_from_cache(source_epub: str, output_dir: Path) -> None:
    """Rebuild an EPUB-backed book from cached source bytes."""
    cached = _find_cached_epub(output_dir, source_epub)
    if not cached:
        raise FileNotFoundError(
            f"No cached EPUB conversion found for {source_epub}. Re-upload the EPUB."
        )

    book_id, md5 = cached
    cached_epub = EPUB_CACHE_DIR / f"{md5}.epub"
    if not cached_epub.exists():
        raise FileNotFoundError(
            f"Cached EPUB missing for MD5 {md5}. Re-upload the EPUB."
        )

    title = Path(source_epub).stem
    book_dir = output_dir / book_id
    timestamp = _utc_now_iso()
    created_at = _read_existing_created_at(book_dir, timestamp)
    print(f"Reconverting EPUB from cache: {source_epub} -> {book_id} (md5={md5})")
    copied_assets = _build_epub_book(cached_epub, output_dir, book_id, title)
    if copied_assets:
        print(f"  Extracted {copied_assets} EPUB assets")

    _write_epub_metadata(
        book_dir,
        book_id=book_id,
        source_epub=source_epub,
        epub_md5=md5,
        created_at=created_at,
        updated_at=timestamp,
    )
    print("  Reconversion complete.")


# --- Markdown processing ---

def _count_words(text: str) -> int:
    """Count words in text."""
    return len(text.split())


LOCAL_ASSET_PATTERN = re.compile(
    r"""
    !\[[^\]]*\]\(([^)]+)\)
    |
    <img\b[^>]*\bsrc=["']([^"']+)["']
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _normalize_markdown_asset_path(raw: str) -> Path | None:
    value = str(raw or "").strip()
    if (
        not value
        or value.startswith(("/", "#", "//", "data:"))
        or re.match(r"^[a-z][a-z0-9+.-]*:", value, flags=re.IGNORECASE)
    ):
        return None

    match = re.match(r"^(?:\.\./|\.?/)*images/(.+)$", value)
    if not match:
        return None

    relative = Path("images") / match.group(1)
    return relative


def _find_local_markdown_assets(markdown: str) -> list[Path]:
    assets: list[Path] = []
    seen: set[str] = set()
    for match in LOCAL_ASSET_PATTERN.finditer(markdown):
        asset = _normalize_markdown_asset_path(match.group(1) or match.group(2))
        if asset is None:
            continue

        key = asset.as_posix()
        if key in seen:
            continue
        seen.add(key)
        assets.append(asset)
    return assets


def _iter_markdown_sidecar_dirs(md_path: Path) -> list[Path]:
    base = md_path.stem
    return [
        md_path.with_suffix(""),
        md_path.parent / f"{base}.assets",
        md_path.parent / f"{base}.files",
        md_path.parent / f"{base}_files",
    ]


def _copy_markdown_sidecars(md_path: Path, article_dir: Path) -> None:
    for candidate in _iter_markdown_sidecar_dirs(md_path):
        if not candidate.is_dir():
            continue

        for item in candidate.iterdir():
            dest = article_dir / item.name
            if dest.exists():
                if dest.is_dir():
                    shutil.rmtree(dest)
                else:
                    dest.unlink()

            if item.is_dir():
                shutil.copytree(item, dest)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, dest)


def _validate_markdown_assets(markdown: str, article_dir: Path) -> None:
    missing = [
        asset.as_posix()
        for asset in _find_local_markdown_assets(markdown)
        if not (article_dir / asset).exists()
    ]
    if not missing:
        return

    names = ", ".join(missing[:3])
    if len(missing) > 3:
        names += ", ..."
    raise ValueError(
        f"Markdown references local assets that were not supplied: {names}. "
        "Add a sidecar asset directory next to the markdown file."
    )


def process_markdown(md_path: Path, output_dir: Path) -> None:
    """Process a single .md file into an article.

    Creates:
      docs/articles/{id}/
        content.md   - the markdown content
        meta.json    - article metadata
    """
    article_id = ensure_unique_content_id(_generate_id(md_path), output_dir.parent, "doc")
    title = md_path.stem
    print(f"Processing markdown: {md_path.name} -> {article_id}")

    content = md_path.read_text(encoding="utf-8")
    word_count = _count_words(content)

    article_dir = output_dir / article_id
    try:
        if article_dir.exists():
            shutil.rmtree(article_dir)
        article_dir.mkdir(parents=True, exist_ok=True)

        # Write content
        (article_dir / "content.md").write_text(content, encoding="utf-8")
        _copy_markdown_sidecars(md_path, article_dir)
        _validate_markdown_assets(content, article_dir)

        # Write metadata
        meta = {
            "id": article_id,
            "type": "doc",
            "title": title,
            "source": md_path.name,
            "word_count": word_count,
            "created_at": _utc_now_iso(),
            "updated_at": _utc_now_iso(),
        }
        (article_dir / "meta.json").write_text(
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except Exception:
        shutil.rmtree(article_dir, ignore_errors=True)
        raise

    # Delete source
    md_path.unlink(missing_ok=True)
    print(f"  Article created: {article_id} ({word_count} words)")


# --- ZIP / static site processing ---

def _flatten_single_root(extract_dir: Path) -> None:
    """If ZIP extracted to a single root folder, flatten it.

    Common pattern: archive contains dist/ or project-name/ wrapping everything.
    """
    entries = list(extract_dir.iterdir())
    if len(entries) == 1 and entries[0].is_dir():
        single_dir = entries[0]
        print(f"  Flattening single root directory: {single_dir.name}/")
        for item in single_dir.iterdir():
            dest = extract_dir / item.name
            if item.is_dir():
                shutil.move(str(item), str(dest))
            else:
                shutil.move(str(item), str(dest))
        single_dir.rmdir()


def process_site(zip_path: Path, output_dir: Path) -> None:
    """Process a .zip file into a static site.

    Extracts to:
      docs/sites/{id}/
        .meta.json   - site metadata (dot-prefixed to avoid conflicts)
        index.html   - required entry point
        ...other files
    """
    site_id = ensure_unique_content_id(_generate_id(zip_path), output_dir.parent, "site")
    print(f"Processing site: {zip_path.name} -> {site_id}")

    site_dir = output_dir / site_id

    # Clean existing site directory for re-upload
    if site_dir.exists():
        shutil.rmtree(site_dir)

    site_dir.mkdir(parents=True, exist_ok=True)

    # Extract ZIP
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(site_dir)
    except zipfile.BadZipFile as exc:
        shutil.rmtree(site_dir, ignore_errors=True)
        raise ValueError(f"Invalid ZIP file: {zip_path.name}: {exc}") from exc

    # Flatten single root directory
    _flatten_single_root(site_dir)

    # Validate index.html exists
    if not (site_dir / "index.html").exists():
        shutil.rmtree(site_dir, ignore_errors=True)
        raise FileNotFoundError(
            f"ZIP must contain index.html at root level: {zip_path.name}"
        )

    # Write metadata (dot-prefixed to not interfere with site files)
    entry = f"sites/{site_id}/index.html"
    meta = {
        "id": site_id,
        "type": "site",
        "title": zip_path.stem,
        "source": zip_path.name,
        "entry": entry,
        "created_at": _utc_now_iso(),
        "updated_at": _utc_now_iso(),
    }
    (site_dir / ".meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    # Delete source
    zip_path.unlink(missing_ok=True)
    print(f"  Site created: {site_id} (entry: {entry})")


# --- Main ---

def _resolve_input_file(input_dir: Path, filename: str) -> Path:
    """Resolve a dispatch filename from input/."""
    target = input_dir / Path(filename).name
    if target.exists():
        return target
    raise FileNotFoundError(f"File not found in input/: {filename}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Process content (PDF, EPUB, Markdown, ZIP).")
    parser.add_argument("--input-dir", type=Path, default=Path("input"))
    parser.add_argument("--output-dir", type=Path, default=Path("docs"))
    args = parser.parse_args()

    books_dir = args.output_dir / "books"
    articles_dir = args.output_dir / "articles"
    sites_dir = args.output_dir / "sites"

    input_filename = os.environ.get("INPUT_FILENAME", "").strip()
    manifest_path = args.output_dir / "manifest.json"
    catalog_path = args.output_dir / "catalog.json"
    metadata_path = args.output_dir / "catalog-metadata.json"

    # Collect jobs by type
    pdf_jobs: list[Path] = []
    epub_jobs: list[Path] = []
    md_jobs: list[Path] = []
    zip_jobs: list[Path] = []

    if input_filename:
        try:
            path = _resolve_input_file(args.input_dir, input_filename)
            ext = path.suffix.lower()
            if ext == ".pdf":
                pdf_jobs = [path]
            elif ext == ".epub":
                epub_jobs = [path]
            elif ext == ".md":
                md_jobs = [path]
            elif ext == ".zip":
                zip_jobs = [path]
            else:
                print(f"Unsupported file type: {input_filename}", file=sys.stderr)
                sys.exit(1)
        except FileNotFoundError:
            # For PDFs, try reconvert from cache
            if input_filename.lower().endswith(".pdf"):
                print(f"PDF not found, attempting reconvert from cache: {input_filename}")
                try:
                    reconvert_from_cache(input_filename, books_dir)
                    build_manifest(
                        books_dir=books_dir,
                        output_path=manifest_path,
                        catalog_metadata_path=metadata_path,
                        catalog_output_path=catalog_path,
                        articles_dir=articles_dir,
                        sites_dir=sites_dir,
                    )
                    print("Manifest rebuilt.")
                    return
                except FileNotFoundError as exc:
                    print(str(exc), file=sys.stderr)
                    sys.exit(1)
            elif input_filename.lower().endswith(".epub"):
                print(f"EPUB not found, attempting reconvert from cache: {input_filename}")
                try:
                    reconvert_epub_from_cache(input_filename, books_dir)
                    build_manifest(
                        books_dir=books_dir,
                        output_path=manifest_path,
                        catalog_metadata_path=metadata_path,
                        catalog_output_path=catalog_path,
                        articles_dir=articles_dir,
                        sites_dir=sites_dir,
                    )
                    print("Manifest rebuilt.")
                    return
                except FileNotFoundError as exc:
                    print(str(exc), file=sys.stderr)
                    sys.exit(1)
            else:
                print(f"File not found: {input_filename}", file=sys.stderr)
                sys.exit(1)
    else:
        pdf_jobs = detect_new_pdfs(args.input_dir)
        epub_jobs = detect_new_epubs(args.input_dir)
        md_jobs = sorted(args.input_dir.glob("*.md"))
        zip_jobs = sorted(args.input_dir.glob("*.zip"))

    total = len(pdf_jobs) + len(epub_jobs) + len(md_jobs) + len(zip_jobs)
    if total == 0:
        print("No new content found in input/. Nothing to do.")
        return

    print(
        f"Found {total} item(s) to process: {len(pdf_jobs)} PDF, "
        f"{len(epub_jobs)} EPUB, {len(md_jobs)} MD, {len(zip_jobs)} ZIP"
    )

    failures: list[tuple[Path, Exception]] = []

    # Process PDFs (existing pipeline)
    for pdf_path in pdf_jobs:
        try:
            convert_single_pdf(pdf_path, books_dir)
        except Exception as exc:
            print(f"  FAILED: {pdf_path.name}: {exc}", file=sys.stderr)
            failures.append((pdf_path, exc))

    # Process EPUB files
    for epub_path in epub_jobs:
        try:
            process_epub(epub_path, books_dir)
            _remove_failure(epub_path.name, args.output_dir)
        except Exception as exc:
            print(f"  FAILED: {epub_path.name}: {exc}", file=sys.stderr)
            failures.append((epub_path, exc))

    # Process Markdown files
    for md_path in md_jobs:
        try:
            process_markdown(md_path, articles_dir)
            _remove_failure(md_path.name, args.output_dir)
        except Exception as exc:
            print(f"  FAILED: {md_path.name}: {exc}", file=sys.stderr)
            failures.append((md_path, exc))

    # Process ZIP files
    for zip_path in zip_jobs:
        try:
            process_site(zip_path, sites_dir)
            _remove_failure(zip_path.name, args.output_dir)
        except Exception as exc:
            print(f"  FAILED: {zip_path.name}: {exc}", file=sys.stderr)
            failures.append((zip_path, exc))

    # Rebuild manifest
    build_manifest(
        books_dir=books_dir,
        output_path=manifest_path,
        catalog_metadata_path=metadata_path,
        catalog_output_path=catalog_path,
        articles_dir=articles_dir,
        sites_dir=sites_dir,
    )
    print("Manifest rebuilt.")

    if failures:
        _write_failures(failures, args.output_dir)
        print(f"\n{len(failures)} item(s) failed:", file=sys.stderr)
        for path, exc in failures:
            print(f"  - {path.name}: {exc}", file=sys.stderr)
    else:
        print("All content processed successfully.")


if __name__ == "__main__":
    main()
