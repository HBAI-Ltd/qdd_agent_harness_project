import gzip
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from prepare_driver_script import prepare


class DriverScriptTests(unittest.TestCase):
    def test_deterministic_gzip_and_exact_saved_content(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "driver.js", Path(folder) / "generated/driver.gz"
            data = b"export const sample = 1;\n" * 100
            source.write_bytes(data)
            report = prepare(source, output)
            first = output.read_bytes()
            self.assertEqual(gzip.decompress(first), data)
            self.assertEqual(first[4:8], bytes(4))
            self.assertEqual(report["sourceSha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(report["gzipBytes"], len(first))
            self.assertLess(len(first), len(data))
            self.assertEqual(prepare(source, output), report)
            self.assertEqual(output.read_bytes(), first)

    def test_limits_utf8_and_no_source_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "driver.js", Path(folder) / "driver.gz"
            for data in (b"", b"a" * 32769, b"\xff"):
                source.write_bytes(data)
                with self.assertRaises(ValueError):
                    prepare(source, output)
                self.assertFalse(output.exists())
            source.write_bytes(b"a" * 32768)
            self.assertEqual(prepare(source, output)["sourceBytes"], 32768)
            with self.assertRaises(ValueError):
                prepare(source, source)
            self.assertEqual(source.read_bytes(), b"a" * 32768)


if __name__ == "__main__":
    unittest.main()
