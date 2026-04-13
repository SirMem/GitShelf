import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
import sys

sys.path.insert(0, str(REPO_ROOT / "scripts"))

import process


class EpubProcessingTest(unittest.TestCase):
    def test_process_epub_converts_to_pdf_and_reuses_pdf_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            books_dir = root / "docs" / "books"
            books_dir.mkdir(parents=True, exist_ok=True)

            epub_path = root / "input" / "sample.epub"
            epub_path.parent.mkdir(parents=True, exist_ok=True)
            epub_path.write_bytes(b"epub-bytes")

            converted_pdfs: list[Path] = []

            def fake_convert_epub_to_pdf(source: Path, dest: Path) -> None:
                self.assertEqual(source, epub_path)
                dest.write_bytes(b"%PDF-1.4\n")
                converted_pdfs.append(dest)

            with patch.object(process, "_convert_epub_to_pdf", side_effect=fake_convert_epub_to_pdf) as convert_mock:
                with patch.object(process, "convert_single_pdf") as convert_pdf_mock:
                    process.process_epub(epub_path, books_dir)

            self.assertFalse(epub_path.exists())
            convert_mock.assert_called_once()
            convert_pdf_mock.assert_called_once()

            args, kwargs = convert_pdf_mock.call_args
            self.assertEqual(args[1], books_dir)
            self.assertEqual(kwargs["source_name"], "sample.epub")
            self.assertEqual(args[0].suffix, ".pdf")
            self.assertEqual(args[0].name, "sample.pdf")
            self.assertGreater(len(converted_pdfs), 0)

    def test_main_reconverts_missing_epub_via_pdf_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            input_dir = root / "input"
            output_dir = root / "docs"
            books_dir = output_dir / "books"
            books_dir.mkdir(parents=True, exist_ok=True)

            env = os.environ.copy()
            env["INPUT_FILENAME"] = "cached.epub"

            with patch.dict(os.environ, env, clear=True):
                with patch.object(process, "reconvert_from_cache") as reconvert_mock:
                    with patch.object(process, "build_manifest") as build_manifest_mock:
                        argv = sys.argv[:]
                        try:
                            sys.argv = [
                                "process.py",
                                "--input-dir",
                                str(input_dir),
                                "--output-dir",
                                str(output_dir),
                            ]
                            process.main()
                        finally:
                            sys.argv = argv

            reconvert_mock.assert_called_once_with("cached.epub", books_dir)
            build_manifest_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
