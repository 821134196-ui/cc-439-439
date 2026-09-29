"""进程内押金模拟适配器。

不接入真实支付：用内存锁保证线程安全，用幂等键保证同一操作重试不重复扣款。
所有动作同时落 deposit_ledger / deposits 两张表，重启后台账仍可追溯。
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime


class DepositError(Exception):
    """押金业务异常（余额不足、已结算等）。"""


class InMemoryDepositAdapter:
    """冻结 / 退还 / 扣减 / 差异补缴 的模拟实现。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        # 模拟远端支付的串行点：同一进程内所有押金动作在此排队，
        # 保证“押金幂等”测试并发重试时只入账一次。
        self._lock = threading.RLock()

    # -- 内部工具 ----------------------------------------------------------

    def _now(self) -> str:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def _ensure_account(self, assignment_id: int) -> None:
        # 只建零金额账户；金额统一由 hold/diff 的 UPDATE 累加，避免双计
        self._conn.execute(
            "INSERT OR IGNORE INTO deposits(assignment_id) VALUES(?)",
            (assignment_id,))

    def _write_ledger(
        self, assignment_id: int, action: str, amount: int,
        key: str, reason: str,
    ) -> bool:
        """写流水。幂等键冲突返回 False（该动作此前已入账）。"""
        try:
            self._conn.execute(
                "INSERT INTO deposit_ledger"
                "(assignment_id, action, amount, idempotency_key, reason, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (assignment_id, action, amount, key, reason, self._now()),
            )
            return True
        except sqlite3.IntegrityError:
            return False

    # -- 对外动作 ----------------------------------------------------------

    def hold(
        self, assignment_id: int, amount: int, key: str, reason: str = "押金冻结"
    ) -> bool:
        with self._lock:
            self._ensure_account(assignment_id)
            if not self._write_ledger(assignment_id, "hold", amount, key, reason):
                return False
            self._conn.execute(
                "UPDATE deposits SET hold_amount=hold_amount+? WHERE assignment_id=?",
                (amount, assignment_id),
            )
            self._conn.commit()
            return True

    def _account(self, assignment_id: int) -> sqlite3.Row:
        row = self._conn.execute(
            "SELECT * FROM deposits WHERE assignment_id=?", (assignment_id,)
        ).fetchone()
        if row is None:
            raise DepositError("该订单无押金账户")
        if row["settled"]:
            raise DepositError("订单已结算，押金已锁定")
        return row

    def refund(
        self, assignment_id: int, amount: int, key: str, reason: str = "押金退还"
    ) -> bool:
        with self._lock:
            acc = self._account(assignment_id)
            available = acc["hold_amount"] - acc["refunded_amount"] - acc["deducted_amount"]
            if amount > available:
                raise DepositError("可退金额不足")
            if not self._write_ledger(assignment_id, "refund", amount, key, reason):
                return False
            self._conn.execute(
                "UPDATE deposits SET refunded_amount=refunded_amount+? WHERE assignment_id=?",
                (amount, assignment_id),
            )
            self._conn.commit()
            return True

    def deduct(
        self, assignment_id: int, amount: int, key: str, reason: str = "押金扣减"
    ) -> bool:
        with self._lock:
            acc = self._account(assignment_id)
            available = acc["hold_amount"] - acc["refunded_amount"] - acc["deducted_amount"]
            if amount > available:
                raise DepositError("押金余额不足以扣减")
            if not self._write_ledger(assignment_id, "deduct", amount, key, reason):
                return False
            self._conn.execute(
                "UPDATE deposits SET deducted_amount=deducted_amount+? WHERE assignment_id=?",
                (amount, assignment_id),
            )
            self._conn.commit()
            return True

    def diff(
        self, assignment_id: int, amount: int, key: str, reason: str = "押金差异补缴"
    ) -> bool:
        """押金差异：需补缴时补冻结，正差（应退）由 refund 处理。"""
        with self._lock:
            self._ensure_account(assignment_id)
            if not self._write_ledger(assignment_id, "diff", amount, key, reason):
                return False
            self._conn.execute(
                "UPDATE deposits SET hold_amount=hold_amount+? WHERE assignment_id=?",
                (amount, assignment_id),
            )
            self._conn.commit()
            return True

    def settle(self, assignment_id: int, key: str) -> dict:
        """结算：退还剩余可退金额并锁定。结算后迟到归还不能重开订单。"""
        with self._lock:
            acc = self._account(assignment_id)
            remaining = (
                acc["hold_amount"] - acc["refunded_amount"] - acc["deducted_amount"]
            )
            if remaining > 0:
                if not self._write_ledger(
                    assignment_id, "refund", remaining, key, "结算尾款退还"
                ):
                    pass
                else:
                    self._conn.execute(
                        "UPDATE deposits SET refunded_amount=refunded_amount+? "
                        "WHERE assignment_id=?",
                        (remaining, assignment_id),
                    )
            self._conn.execute(
                "UPDATE deposits SET settled=1, settled_at=? WHERE assignment_id=?",
                (self._now(), assignment_id),
            )
            self._conn.commit()
            return self.summary(assignment_id)

    def summary(self, assignment_id: int) -> dict:
        with self._lock:
            acc = self._conn.execute(
                "SELECT * FROM deposits WHERE assignment_id=?", (assignment_id,)
            ).fetchone()
            if acc is None:
                return {"hold": 0, "refunded": 0, "deducted": 0, "settled": False,
                        "balance": 0}
            return {
                "hold": acc["hold_amount"],
                "refunded": acc["refunded_amount"],
                "deducted": acc["deducted_amount"],
                "settled": bool(acc["settled"]),
                "settled_at": acc["settled_at"],
                "balance": acc["hold_amount"]
                           - acc["refunded_amount"] - acc["deducted_amount"],
            }
