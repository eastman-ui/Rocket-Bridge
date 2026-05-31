import os, tempfile, textwrap, pytest
from converter import _parse_rasaero_csv

VALID_CSV = textwrap.dedent("""\
    Mach,Alpha,CD,CD Power-Off,CD Power-On,CA Power-Off,CA Power-On,CL,CN
    0.5,0,0.56,0.56,0.54,0.56,0.54,0,0
    1.0,0,0.76,0.76,0.72,0.76,0.72,0,0
    0.8,0,0.58,0.58,0.56,0.58,0.56,0,0
""")

def test_valid_csv_writes_two_col_sorted():
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "rasaero.csv")
        with open(src, "w") as f:
            f.write(VALID_CSV)
        out = _parse_rasaero_csv(src, tmp)
        assert os.path.exists(out)
        import numpy as np
        data = np.loadtxt(out, delimiter=",")
        assert data.shape[1] == 2
        assert list(data[:, 0]) == sorted(data[:, 0])
        assert abs(data[0, 1] - 0.56) < 1e-5
        assert abs(data[1, 1] - 0.58) < 1e-5
        assert abs(data[2, 1] - 0.76) < 1e-5

def test_missing_header_raises():
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "bad.csv")
        with open(src, "w") as f:
            f.write("A,B,C\n1,2,3\n")
        with pytest.raises(ValueError, match="Mach"):
            _parse_rasaero_csv(src, tmp)

def test_non_numeric_raises():
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "bad.csv")
        with open(src, "w") as f:
            f.write("Mach,Alpha,CD,CD Power-Off\n0.5,0,0.56,abc\n")
        with pytest.raises(ValueError, match="numeric"):
            _parse_rasaero_csv(src, tmp)

def test_deduplicates_mach():
    dup_csv = textwrap.dedent("""\
        Mach,Alpha,CD,CD Power-Off
        0.5,0,0.56,0.56
        0.5,2,0.57,0.57
        1.0,0,0.76,0.76
    """)
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "dup.csv")
        with open(src, "w") as f:
            f.write(dup_csv)
        out = _parse_rasaero_csv(src, tmp)
        import numpy as np
        data = np.loadtxt(out, delimiter=",")
        assert data.shape[0] == 2
