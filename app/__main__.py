"""命令行入口。

用法：
    python3 -m app            # 首次自动生成演示样例（申请/归还/隔离）并启动
    python3 -m app --reseed   # 重置并重新生成样例
    python3 -m app --no-seed  # 不重建数据，沿用现有数据库
"""
from __future__ import annotations

import argparse
from pathlib import Path

from .db import connect, init_db
from .seed import seed_all
from .server import serve


def main() -> None:
    ap = argparse.ArgumentParser(description="医院陪护床位与消毒交接系统")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--db", default="data/hospital.db")
    ap.add_argument("--photos", default="data/photos")
    ap.add_argument("--reseed", action="store_true", help="重置并重新生成样例")
    ap.add_argument("--no-seed", action="store_true", help="不生成演示数据")
    args = ap.parse_args()

    db_path = Path(args.db)
    fresh = args.reseed or (not args.no_seed and not db_path.exists())
    if fresh and not args.no_seed:
        # 启动前一次性生成申请、归还、隔离等全部样例
        conn = connect(db_path)
        init_db(conn)
        seed_all(conn, args.photos, reset=args.reseed)
        conn.close()
        print("已生成演示样例：申请队列、归还核验、污染隔离、超时、换床、"
              "消毒失败、维修与调拨。")

    serve(args.host, args.port, str(db_path), args.photos, reseed=False)


if __name__ == "__main__":
    main()
