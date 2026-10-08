"""推理会话池：LRU + TTL(纯逻辑,无 torch 依赖,可单测)。"""

import threading
import time
import uuid
from collections import OrderedDict
from typing import Any, Callable, Generic, TypeVar

HandleT = TypeVar("HandleT")


class Session(Generic[HandleT]):
    __slots__ = ("id", "handle", "width", "height", "created", "last_used")

    def __init__(self, sid: str, handle: HandleT, width: int, height: int, now: float):
        self.id = sid
        self.handle = handle
        self.width = width
        self.height = height
        self.created = now
        self.last_used = now


class SessionStore:
    """线程安全的 LRU+TTL 会话池。

    - touch 语义:get 成功即刷新 LRU 位次与 last_used
    - 淘汰:容量超限挤掉最久未用;过期由 sweep() / get 时惰性清除
    """

    def __init__(
        self,
        max_sessions: int = 32,
        ttl_seconds: float = 600.0,
        clock: Callable[[], float] = time.monotonic,
        on_evict: Callable[[Session[Any]], None] | None = None,
    ):
        self._max = max_sessions
        self._ttl = ttl_seconds
        self._clock = clock
        self._on_evict = on_evict
        self._lock = threading.Lock()
        self._map: OrderedDict[str, Session[Any]] = OrderedDict()

    def _expired(self, s: Session[Any]) -> bool:
        return (self._clock() - s.last_used) > self._ttl

    def put(self, handle: Any, width: int, height: int) -> str:
        sid = str(uuid.uuid4())
        now = self._clock()
        with self._lock:
            while len(self._map) >= self._max:
                _, oldest = self._map.popitem(last=False)
                if self._on_evict:
                    self._on_evict_safe(oldest)
            self._map[sid] = Session(sid, handle, width, height, now)
        return sid

    def _on_evict_safe(self, s: Session[Any]) -> None:
        assert self._on_evict is not None
        try:
            self._on_evict(s)
        except Exception:  # noqa: BLE001 - 清理回调不允许影响会话池
            pass

    def get(self, sid: str) -> Session[Any] | None:
        with self._lock:
            s = self._map.get(sid)
            if s is None:
                return None
            if self._expired(s):
                del self._map[sid]
                if self._on_evict:
                    self._on_evict_safe(s)
                return None
            s.last_used = self._clock()
            self._map.move_to_end(sid)
            return s

    def sweep(self) -> int:
        """清除全部过期会话,返回清除数(后台线程周期调用)。"""
        removed = 0
        with self._lock:
            expired = [sid for sid, s in self._map.items() if self._expired(s)]
            for sid in expired:
                s = self._map.pop(sid)
                if self._on_evict:
                    self._on_evict_safe(s)
                removed += 1
        return removed

    def __len__(self) -> int:
        with self._lock:
            return len(self._map)
