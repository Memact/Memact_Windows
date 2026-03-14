import os
import sys
import warnings
from pathlib import Path

os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "0")
os.environ.setdefault("QT_AUTO_SCREEN_SCALE_FACTOR", "0")

warnings.filterwarnings(
    "ignore",
    message=r"Apply externally defined coinit_flags: 2",
    module="pywinauto",
)

from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication

sys.coinit_flags = 2

from ui.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("MemAct")
    app.setQuitOnLastWindowClosed(False)
    base_dir = Path(__file__).resolve().parent

    icon_path = base_dir / "assets" / "memact_icon.svg"
    if icon_path.exists():
        app.setWindowIcon(QIcon(str(icon_path)))

    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
