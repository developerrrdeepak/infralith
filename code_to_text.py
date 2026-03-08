import fnmatch
import json
import os
import sys
from pathlib import Path

# Ensure UTF-8 encoding for console output on Windows.
if sys.platform == "win32" and hasattr(sys.stdout, "buffer"):
    import io

    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

INCLUDE_EXTENSIONS = [
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".css",
    ".html",
    ".ipynb",
]

EXCLUDE_FILES = [
    "package-lock.json",
    "package.json",
    ".gitignore",
    ".env",
    ".env.local",
    "requirements.txt",
    "README.md",
    "poetry.lock",
    "yarn.lock",
    "tsconfig.json",
    "tsconfig.tsbuildinfo",
    "project_structure.txt",
    "project.txt",
    "code_to_text.py",
    "*.json",
    "*.lock",
    "*.png",
    "*.jpg",
    "*.svg",
]

EXCLUDE_DIRS = {
    ".azure",
    ".config",
    "node_modules",
    ".git",
    "public",
    "build",
    ".next",
    "venv",
    ".venv",
    "__pycache__",
    "Reference Papers",
    "dist",
    "coverage",
    "assets",
    "images",
    "data",
    "output",
}


def get_file_folder_structure(repo_path: str) -> str:
    structure = ""
    for root, dirs, files in os.walk(repo_path, topdown=True):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

        level = root.replace(repo_path, "").count(os.sep)
        indent = " " * 4 * level
        structure += f"{os.path.basename(root) if level == 0 else indent + os.path.basename(root)}/\n"

        subindent = " " * 4 * (level + 1)
        for name in sorted(files):
            if any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDE_FILES):
                continue
            structure += f"{subindent}{name}\n"
    return structure


def parse_ipynb_content(content: str) -> str:
    try:
        notebook = json.loads(content)
        parsed_content = ""
        for i, cell in enumerate(notebook.get("cells", []), start=1):
            cell_type = cell.get("cell_type", "")
            source = cell.get("source", [])
            if isinstance(source, list):
                source = "".join(source)

            if cell_type == "markdown":
                parsed_content += f"# Markdown Cell {i}:\n{source}\n\n"
            elif cell_type == "code":
                parsed_content += f"# Code Cell {i}:\n{source}\n\n"
        return parsed_content
    except Exception as error:
        return f"Error parsing notebook: {error}"


def extract_code_files(repo_path: str) -> str:
    compiled_contents = ""
    compiled_contents += "Project Structure:\n"
    compiled_contents += "==================\n"
    compiled_contents += get_file_folder_structure(repo_path)
    compiled_contents += "\n\nFile Contents:\n"
    compiled_contents += "==================\n\n"

    for root, dirs, files in os.walk(repo_path, topdown=True):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

        for file_name in files:
            if any(fnmatch.fnmatch(file_name, pattern) for pattern in EXCLUDE_FILES):
                continue

            if not any(file_name.endswith(ext) for ext in INCLUDE_EXTENSIONS):
                continue

            file_path = os.path.join(root, file_name)
            try:
                with open(file_path, "r", encoding="utf-8") as file_handle:
                    compiled_contents += "---\n"
                    compiled_contents += (
                        f"File: {os.path.relpath(file_path, start=repo_path)}\n"
                    )

                    if file_name.endswith(".ipynb"):
                        compiled_contents += (
                            "```python\n"
                            + parse_ipynb_content(file_handle.read())
                            + "\n```\n\n"
                        )
                    else:
                        ext = os.path.splitext(file_name)[1]
                        lang_map = {
                            ".py": "python",
                            ".js": "javascript",
                            ".jsx": "javascript",
                            ".ts": "typescript",
                            ".tsx": "tsx",
                            ".html": "html",
                            ".css": "css",
                        }
                        lang = lang_map.get(ext, "")
                        compiled_contents += f"```{lang}\n{file_handle.read()}\n```\n\n"
            except Exception as error:
                compiled_contents += f"Error reading file: {error}\n\n"

    return compiled_contents


if __name__ == "__main__":
    script_dir = Path(__file__).resolve().parent
    repo_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else script_dir
    output_file = (
        Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else script_dir / "project.txt"
    )

    print(f"Processing {repo_path}...")
    content = extract_code_files(str(repo_path))

    with open(output_file, "w", encoding="utf-8") as file_handle:
        file_handle.write(content)

    print(f"Done! Saved to {output_file}")
