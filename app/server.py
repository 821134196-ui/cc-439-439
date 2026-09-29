"""HTTP 服务：JSON API + 前端静态文件 + 本地交接照片。

仅用标准库 http.server，单进程多线程；写操作由 Service 内部锁与 SQLite
事务/唯一索引保证并发安全。
"""
from __future__ import annotations

import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .db import connect, init_db
from .seed import seed_all
from .services import Service, ServiceError

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


class AppState:
    def __init__(self, db_path: str, photos_dir: str, reseed: bool = False):
        self.conn = connect(db_path)
        init_db(self.conn)
        if reseed:
            seed_all(self.conn, photos_dir, reset=True)
        self.svc = Service(self.conn, photos_dir)
        self.lock = threading.Lock()  # 串行化简单写操作（分配另有 alloc_lock）


def fen(v) -> int:
    return int(round(float(v) * 100))


class Handler(BaseHTTPRequestHandler):
    state: AppState = None  # 由 main 注入

    # -- 基础工具 ----------------------------------------------------------

    def log_message(self, fmt, *args):  # 安静一点
        pass

    def _json(self, obj, status: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, code: str = "error", status: int = 400):
        self._json({"ok": False, "error": message, "code": code}, status)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _file(self, path: Path):
        if not path.is_file():
            self._error("文件不存在", "not_found", 404)
            return
        body = path.read_bytes()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- 路由 --------------------------------------------------------------

    def do_GET(self):
        p = urlparse(self.path).path
        try:
            if p == "/api/meta":
                return self._json(self._meta())
            if p == "/api/bedmap":
                return self._json({"ok": True, "wards": self.state.svc.bed_map()})
            if p == "/api/queue":
                return self._json({"ok": True, "requests":
                                   self.state.svc.request_queue()})
            if p == "/api/timeline":
                return self._json({"ok": True, "assignments":
                                   self.state.svc.timeline()})
            if p == "/api/batches":
                return self._json({"ok": True, "batches":
                                   self.state.svc.batches()})
            if p == "/api/exceptions":
                return self._json({"ok": True, "exceptions":
                                   self.state.svc.exceptions()})
            if p == "/api/transfers":
                return self._json({"ok": True, "transfers":
                                   self.state.svc.transfers()})
            if p.startswith("/api/assignment/"):
                aid = int(p.rsplit("/", 1)[-1])
                return self._json(self._assignment_detail(aid))
            if p.startswith("/photos/"):
                name = Path(p[len("/photos/"):]).name
                return self._file(self.state.svc.photos_dir / name)
            # 静态前端
            if p == "/" or p == "":
                return self._file(STATIC_DIR / "index.html")
            if p.startswith("/static/"):
                rel = p[len("/static/"):]
                target = (STATIC_DIR / rel).resolve()
                if STATIC_DIR.resolve() in target.parents or target == STATIC_DIR.resolve():
                    return self._file(target)
            return self._error("未找到", "not_found", 404)
        except ServiceError as e:
            return self._error(str(e), e.code)
        except Exception as e:  # noqa: BLE001
            return self._error(f"服务器错误：{e}", "server_error", 500)

    def do_POST(self):
        p = urlparse(self.path).path
        data = self._body()
        svc = self.state.svc
        try:
            if p == "/api/assign":
                res = svc.assign(
                    int(data["request_id"]), int(data["bed_id"]),
                    int(data["nurse_id"]), data.get("idempotency_key"))
                return self._json({"ok": True, **res})
            if p == "/api/return":
                res = svc.return_bed(
                    int(data["assignment_id"]), int(data["nurse_id"]),
                    data.get("items", {}), data.get("photo_b64", ""),
                    data.get("photo_name", ""))
                return self._json({"ok": True, **res})
            if p == "/api/batch/create":
                res = svc.create_batch(
                    int(data["bed_id"]), int(data["nurse_id"]),
                    str(data.get("operator", "消毒员")))
                return self._json({"ok": True, **res})
            if p == "/api/batch/finish":
                res = svc.finish_batch(
                    int(data["batch_id"]), bool(data.get("passed", True)),
                    str(data.get("note", "")))
                return self._json({"ok": True, **res})
            if p == "/api/maintenance/open":
                res = svc.open_maintenance(
                    int(data["bed_id"]), str(data.get("reason", "")),
                    str(data.get("opened_by", "")))
                return self._json({"ok": True, **res})
            if p == "/api/maintenance/close":
                svc.close_maintenance(int(data["bed_id"]))
                return self._json({"ok": True})
            if p == "/api/swap":
                res = svc.swap_bed(
                    int(data["assignment_id"]), int(data["to_bed_id"]),
                    int(data["nurse_id"]), str(data.get("reason", "")))
                return self._json({"ok": True, **res})
            if p == "/api/transfer":
                res = svc.transfer(
                    int(data["from_ward_id"]), int(data["to_ward_id"]),
                    int(data["qty"]), str(data.get("responsible_person", "")),
                    int(data["nurse_id"]), str(data.get("item_type", "陪护床")),
                    str(data.get("note", "")))
                return self._json({"ok": True, **res})
            if p == "/api/settle":
                deduct = fen(data["deduct_yuan"]) if data.get("deduct_yuan") else 0
                res = svc.settle(
                    int(data["assignment_id"]), deduct,
                    str(data.get("deduct_reason", "")))
                return self._json({"ok": True, "deposit": res})
            return self._error("未知接口", "not_found", 404)
        except ServiceError as e:
            return self._error(str(e), e.code)
        except KeyError as e:
            return self._error(f"缺少参数：{e}", "bad_param")
        except ValueError as e:
            return self._error(f"参数格式错误：{e}", "bad_param")
        except Exception as e:  # noqa: BLE001
            return self._error(f"服务器错误：{e}", "server_error", 500)

    # -- 聚合数据 ----------------------------------------------------------

    def _meta(self) -> dict:
        c = self.state.conn
        return {
            "ok": True,
            "wards": [dict(r) for r in c.execute(
                "SELECT * FROM wards ORDER BY id")],
            "nurses": [dict(r) for r in c.execute(
                "SELECT n.*, w.name AS ward_name FROM nurses n "
                "JOIN wards w ON w.id=n.ward_id ORDER BY n.id")],
            "beds": [dict(r) for r in c.execute(
                "SELECT id, code, ward_id, spec, cleaning_status, maintenance"
                " FROM beds ORDER BY code")],
        }

    def _assignment_detail(self, aid: int) -> dict:
        c = self.state.conn
        asg = c.execute(
            "SELECT asg.*, b.code AS bed_code, b.spec, w.name AS ward_name,"
            " n.name AS nurse_name, a.patient_tag "
            "FROM assignments asg "
            "JOIN beds b ON b.id=asg.bed_id "
            "JOIN wards w ON w.id=asg.ward_id "
            "JOIN nurses n ON n.id=asg.nurse_id "
            "JOIN requests r ON r.id=asg.request_id "
            "JOIN applicants a ON a.id=r.applicant_id "
            "WHERE asg.id=?", (aid,)).fetchone()
        if asg is None:
            return {"ok": False, "error": "订单不存在", "code": "not_found"}
        items = [dict(r) for r in c.execute(
            "SELECT * FROM bed_items WHERE assignment_id=? ORDER BY id", (aid,))]
        ret = c.execute("SELECT * FROM returns WHERE assignment_id=?",
                        (aid,)).fetchone()
        return {
            "ok": True,
            "assignment": dict(asg),
            "items": items,
            "return": dict(ret) if ret else None,
            "deposit": self.state.svc.deposits.summary(aid),
            "swaps": [dict(r) for r in c.execute(
                "SELECT s.*, b1.code AS from_code, b2.code AS to_code "
                "FROM swaps s "
                "JOIN beds b1 ON b1.id=s.from_bed_id "
                "JOIN beds b2 ON b2.id=s.to_bed_id "
                "WHERE s.assignment_id=? ORDER BY s.id", (aid,))],
        }


def serve(host: str, port: int, db_path: str, photos_dir: str,
          reseed: bool = False) -> None:
    state = AppState(db_path, photos_dir, reseed=reseed)
    Handler.state = state
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"陪护床位与消毒交接系统已启动: http://{host}:{port}")
    print(f"数据库: {db_path}  照片目录: {photos_dir}")
    httpd.serve_forever()
