import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from build_manifest import build_manifest


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _create_book(
    books_dir: Path,
    *,
    book_id: str,
    title: str,
    source: str | None = None,
    source_format: str | None = None,
    toc_children: list[dict] | None = None,
) -> None:
    book_dir = books_dir / book_id
    book_dir.mkdir(parents=True, exist_ok=True)
    _write_json(book_dir / "toc.json", {"title": title, "children": toc_children or []})

    chapters_dir = book_dir / "chapters"
    chapters_dir.mkdir(parents=True, exist_ok=True)
    (chapters_dir / "01-intro.md").write_text("# Intro\n\nhello world\n", encoding="utf-8")

    if source or source_format:
        data = {
            "id": book_id,
            "type": "book",
            "page_count": 8,
            "created_at": "2026-03-25T10:00:00Z",
            "updated_at": "2026-03-25T10:00:00Z",
        }
        if source:
            data["source"] = source
        if source_format:
            data["source_format"] = source_format
        _write_json(
            book_dir / "meta.json",
            data,
        )


def _create_article(articles_dir: Path, *, article_id: str, title: str) -> None:
    article_dir = articles_dir / article_id
    article_dir.mkdir(parents=True, exist_ok=True)
    (article_dir / "content.md").write_text(f"# {title}\n\nhello world\n", encoding="utf-8")
    _write_json(
        article_dir / "meta.json",
        {
            "id": article_id,
            "type": "doc",
            "title": title,
            "source": f"{article_id}.md",
            "created_at": "2026-03-25T10:00:00Z",
            "updated_at": "2026-03-25T10:00:00Z",
        },
    )


class BuildManifestTest(unittest.TestCase):
    def test_merge_metadata_and_filter_public_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            books_dir = root / "docs" / "books"
            articles_dir = root / "docs" / "articles"
            sites_dir = root / "docs" / "sites"
            manifest_path = root / "docs" / "manifest.json"
            metadata_path = root / "docs" / "catalog-metadata.json"
            catalog_path = root / "docs" / "catalog.json"

            _create_book(books_dir, book_id="book-one", title="Raw One", source="source-one.pdf")
            _create_book(books_dir, book_id="book-two", title="Raw Two", source="source-two.pdf")

            _write_json(
                metadata_path,
                {
                    "items": [
                        {
                            "id": "book-one",
                            "type": "book",
                            "display_title": "Curated One",
                            "author": "Alice",
                            "visibility": "hidden",
                            "tags": ["ml"],
                            "featured": True,
                            "manual_order": 5,
                        },
                        {
                            "id": "book-two",
                            "type": "book",
                            "display_title": "Curated Two",
                            "summary": "Public summary",
                            "visibility": "published",
                            "manual_order": 1,
                        },
                    ]
                },
            )

            build_manifest(
                books_dir=books_dir,
                output_path=manifest_path,
                catalog_metadata_path=metadata_path,
                catalog_output_path=catalog_path,
                articles_dir=articles_dir,
                sites_dir=sites_dir,
            )

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual([item["id"] for item in manifest["items"]], ["book-two"])
            public_item = manifest["items"][0]
            self.assertEqual(public_item["title"], "Curated Two")
            self.assertEqual(public_item["type"], "book")
            self.assertEqual(public_item["source"], "source-two.pdf")
            self.assertEqual(public_item["source_format"], "markdown-derived")

            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            by_id = {item["id"]: item for item in catalog["items"]}
            self.assertEqual(set(by_id.keys()), {"book-one", "book-two"})
            self.assertEqual(by_id["book-one"]["generated_title"], "Raw One")
            self.assertEqual(by_id["book-one"]["title"], "Curated One")
            self.assertEqual(by_id["book-one"]["visibility"], "hidden")
            self.assertEqual(by_id["book-one"]["source"], "source-one.pdf")
            self.assertEqual(by_id["book-one"]["source_format"], "markdown-derived")

    def test_create_default_metadata_and_source_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            books_dir = root / "docs" / "books"
            articles_dir = root / "docs" / "articles"
            sites_dir = root / "docs" / "sites"
            manifest_path = root / "docs" / "manifest.json"
            metadata_path = root / "docs" / "catalog-metadata.json"
            catalog_path = root / "docs" / "catalog.json"

            _create_book(books_dir, book_id="book-three", title="Raw Three", source=None)

            build_manifest(
                books_dir=books_dir,
                output_path=manifest_path,
                catalog_metadata_path=metadata_path,
                catalog_output_path=catalog_path,
                articles_dir=articles_dir,
                sites_dir=sites_dir,
            )

            self.assertTrue(metadata_path.exists())
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(metadata, {"items": []})

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["items"][0]["source"], "book-three.pdf")
            self.assertEqual(manifest["items"][0]["type"], "book")
            self.assertEqual(manifest["items"][0]["source_format"], "markdown-derived")

    def test_books_can_keep_original_epub_source_name_after_conversion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            books_dir = root / "docs" / "books"
            articles_dir = root / "docs" / "articles"
            sites_dir = root / "docs" / "sites"
            manifest_path = root / "docs" / "manifest.json"
            metadata_path = root / "docs" / "catalog-metadata.json"
            catalog_path = root / "docs" / "catalog.json"

            _create_book(
                books_dir,
                book_id="epub-book",
                title="EPUB Book",
                source="epub-book.epub",
                source_format="markdown-derived",
                toc_children=[
                    {
                        "title": "Chapter One",
                        "slug": "chapter-one",
                        "href": "chapter-1",
                        "children": [
                            {
                                "title": "Section One",
                                "slug": "section-one",
                                "href": "chapter-1",
                                "anchor": "section-1",
                            }
                        ],
                    },
                    {
                        "title": "Chapter Two",
                        "slug": "chapter-two",
                        "href": "chapter-2",
                    },
                ],
            )

            build_manifest(
                books_dir=books_dir,
                output_path=manifest_path,
                catalog_metadata_path=metadata_path,
                catalog_output_path=catalog_path,
                articles_dir=articles_dir,
                sites_dir=sites_dir,
            )

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["items"][0]["chapters_count"], 1)
            self.assertEqual(manifest["items"][0]["word_count"], 4)
            self.assertEqual(manifest["items"][0]["source"], "epub-book.epub")
            self.assertEqual(manifest["items"][0]["source_format"], "markdown-derived")

    def test_invalid_metadata_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            books_dir = root / "docs" / "books"
            articles_dir = root / "docs" / "articles"
            sites_dir = root / "docs" / "sites"
            manifest_path = root / "docs" / "manifest.json"
            metadata_path = root / "docs" / "catalog-metadata.json"
            catalog_path = root / "docs" / "catalog.json"

            _create_book(books_dir, book_id="book-four", title="Raw Four", source="book-four.pdf")
            _write_json(
                metadata_path,
                {
                    "items": [
                        {
                            "id": "book-four",
                            "type": "book",
                            "manual_order": "not-an-int",
                            "visibility": "draft",
                        }
                    ]
                },
            )

            with self.assertRaisesRegex(ValueError, "Invalid catalog metadata for book-four"):
                build_manifest(
                    books_dir=books_dir,
                    output_path=manifest_path,
                    catalog_metadata_path=metadata_path,
                    catalog_output_path=catalog_path,
                    articles_dir=articles_dir,
                    sites_dir=sites_dir,
                )

    def test_typed_metadata_can_distinguish_same_id_across_content_types(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            books_dir = root / "docs" / "books"
            articles_dir = root / "docs" / "articles"
            manifest_path = root / "docs" / "manifest.json"
            metadata_path = root / "docs" / "catalog-metadata.json"
            catalog_path = root / "docs" / "catalog.json"

            _create_book(books_dir, book_id="shared-id", title="Raw Book", source="shared.pdf")
            _create_article(articles_dir, article_id="shared-id", title="Raw Article")

            _write_json(
                metadata_path,
                {
                    "items": [
                        {"id": "shared-id", "type": "book", "display_title": "Curated Book"},
                        {"id": "shared-id", "type": "doc", "display_title": "Curated Article"},
                    ]
                },
            )

            with self.assertRaisesRegex(ValueError, "Duplicate content id 'shared-id'"):
                build_manifest(
                    books_dir=books_dir,
                    articles_dir=articles_dir,
                    output_path=manifest_path,
                    catalog_metadata_path=metadata_path,
                    catalog_output_path=catalog_path,
                )


if __name__ == "__main__":
    unittest.main()
