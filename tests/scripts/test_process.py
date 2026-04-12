import json
import subprocess
import sys
import tempfile
import unittest
import hashlib
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import process


class EpubProcessingTest(unittest.TestCase):
    def test_process_epub_builds_book_structure_and_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            books_dir = root / "docs" / "books"
            books_dir.mkdir(parents=True, exist_ok=True)

            epub_path = root / "input" / "sample.epub"
            epub_path.parent.mkdir(parents=True, exist_ok=True)
            epub_path.write_bytes(b"epub-bytes")

            markdown = """
<span id="intro.xhtml"></span>

<div class="section level2">
## Chapter One

![Cover](media/cover.png)

### Section One

Hello world.
</div>

<div class="section level2">
## Chapter Two

### Section Two

More text.
</div>
""".strip()

            def fake_run(cmd, check, cwd, capture_output, text):
                work_dir = Path(cwd)
                (work_dir / "book.md").write_text(markdown, encoding="utf-8")
                media_dir = work_dir / "media"
                media_dir.mkdir(parents=True, exist_ok=True)
                (media_dir / "cover.png").write_bytes(b"png")
                return subprocess.CompletedProcess(cmd, 0, "", "")

            cache_dir = root / "cache" / "epub"
            with patch.object(process, "EPUB_CACHE_DIR", cache_dir), patch.object(
                process, "_utc_now_iso", return_value="2026-04-12T12:00:00Z"
            ), patch.object(process.subprocess, "run", side_effect=fake_run):
                process.process_epub(epub_path, books_dir)

            book_dir = books_dir / "sample"
            expected_md5 = hashlib.md5(b"epub-bytes").hexdigest()
            self.assertFalse(epub_path.exists())
            self.assertTrue((book_dir / "images" / "cover.png").exists())
            self.assertTrue((cache_dir / f"{expected_md5}.epub").exists())

            toc = json.loads((book_dir / "toc.json").read_text(encoding="utf-8"))
            self.assertEqual(toc["title"], "sample")
            self.assertEqual(toc["children"][0]["title"], "Chapter One")
            self.assertEqual(toc["children"][0]["children"][0]["title"], "Section One")
            self.assertEqual(toc["children"][1]["title"], "Chapter Two")

            chapter_one = (book_dir / "chapters" / "01-chapter-one.md").read_text(encoding="utf-8")
            self.assertIn("![Cover](../images/cover.png)", chapter_one)
            self.assertNotIn("<span", chapter_one)
            self.assertNotIn("<div", chapter_one)

            meta = json.loads((book_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["source"], "sample.epub")
            self.assertEqual(meta["source_format"], "epub")
            self.assertEqual(meta["epub_md5"], expected_md5)
            self.assertEqual(meta["created_at"], "2026-04-12T12:00:00Z")
            self.assertEqual(meta["updated_at"], "2026-04-12T12:00:00Z")

    def test_reconvert_epub_from_cache_uses_cached_source_and_preserves_created_at(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            books_dir = root / "docs" / "books"
            book_dir = books_dir / "cached-book"
            book_dir.mkdir(parents=True, exist_ok=True)
            (book_dir / "meta.json").write_text(
                json.dumps(
                    {
                        "id": "cached-book",
                        "type": "book",
                        "source": "cached.epub",
                        "source_format": "epub",
                        "epub_md5": "abc123",
                        "created_at": "2026-04-10T08:00:00Z",
                        "updated_at": "2026-04-10T08:00:00Z",
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            cache_dir = root / "cache" / "epub"
            cache_dir.mkdir(parents=True, exist_ok=True)
            (cache_dir / "abc123.epub").write_bytes(b"cached-epub")

            markdown = """
<div class="section level1">
# Chapter One

Body text.
</div>

<div class="section level1">
# Chapter Two

More text.
</div>
""".strip()

            def fake_run(cmd, check, cwd, capture_output, text):
                (Path(cwd) / "book.md").write_text(markdown, encoding="utf-8")
                return subprocess.CompletedProcess(cmd, 0, "", "")

            with patch.object(process, "EPUB_CACHE_DIR", cache_dir), patch.object(
                process, "_utc_now_iso", return_value="2026-04-12T12:00:00Z"
            ), patch.object(process.subprocess, "run", side_effect=fake_run):
                process.reconvert_epub_from_cache("cached.epub", books_dir)

            toc = json.loads((book_dir / "toc.json").read_text(encoding="utf-8"))
            self.assertEqual([entry["title"] for entry in toc["children"]], ["Chapter One", "Chapter Two"])

            meta = json.loads((book_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["created_at"], "2026-04-10T08:00:00Z")
            self.assertEqual(meta["updated_at"], "2026-04-12T12:00:00Z")


if __name__ == "__main__":
    unittest.main()
