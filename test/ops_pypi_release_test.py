"""The PyPI release script's checks on the package's own files (no build, no network)."""
import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "clients" / "python-sdk" / "src"))
spec = importlib.util.spec_from_file_location("release_python_sdk", ROOT / "ops" / "pypi" / "release_python_sdk.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseCheckTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder)
        self.sdk = Path(folder) / "python-sdk"
        shutil.copytree(ROOT / "clients" / "python-sdk", self.sdk,
                        ignore=shutil.ignore_patterns("__pycache__", "*.egg-info", "build", "dist"))

    def edit(self, name, old, new):
        path = self.sdk / name
        text = path.read_text()
        self.assertIn(old, text)
        path.write_text(text.replace(old, new))

    def test_reads_the_version_the_package_will_have(self):
        from fetchx import __version__
        self.assertEqual(release.sdk_version(self.sdk), __version__)
        self.edit("src/fetchx/_version.py", __version__, "0.2")
        with self.assertRaises(release.ReleaseError):
            release.sdk_version(self.sdk)

    def test_a_release_needs_a_license_the_pypi_install_line_and_absolute_links(self):
        (self.sdk / "LICENSE").unlink()
        self.assertTrue(any("no LICENSE file" in problem for problem in release.source_problems(self.sdk)))
        (self.sdk / "LICENSE").write_text("MIT License\n")
        self.edit("pyproject.toml", 'license = "MIT"\n', "")
        problems = release.source_problems(self.sdk)
        self.assertTrue(any("no license" in problem for problem in problems), problems)
        self.edit("pyproject.toml", 'name = "fetchx-sdk"', 'name = "fetchx-sdk"\nlicense = "MIT"')
        self.assertEqual(release.source_problems(self.sdk), [])
        from_github = 'pip install "fetchx-sdk @ git+https://github.com/karthikbala/FetchX.git#subdirectory=clients/python-sdk"'
        self.edit("README.md", release.INSTALL_LINE, from_github)
        problems = release.source_problems(self.sdk)
        self.assertTrue(any("should install with" in problem for problem in problems), problems)
        self.edit("README.md", from_github, release.INSTALL_LINE)
        self.assertEqual(release.source_problems(self.sdk), [])
        self.edit("README.md", "](https://github.com/karthikbala/FetchX/blob/main/clients/python.py)", "](../python.py)")
        self.assertEqual(release.source_problems(self.sdk), ["README.md has relative links, which break on PyPI"])


if __name__ == "__main__":
    unittest.main()
