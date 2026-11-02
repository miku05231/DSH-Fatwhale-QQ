"""Keep native descendants within their generation's process lifetime."""
from __future__ import annotations

import os
import signal
import sys
from collections.abc import Mapping


def python_child_launch(env: Mapping[str, str] | None = None) -> tuple[str, dict[str, str]]:
    """Return an executable and environment that preserve venv child PIDs on Windows."""
    child_env = dict(os.environ if env is None else env)
    if os.name != "nt":
        return sys.executable, child_env

    base_executable = getattr(sys, "_base_executable", None)
    if (
        not isinstance(base_executable, str)
        or not os.path.isabs(base_executable)
        or not os.path.isfile(base_executable)
    ):
        raise RuntimeError("ASTRBOT_PYTHON_LAUNCHER_UNAVAILABLE")
    child_env["__PYVENV_LAUNCHER__"] = sys.executable
    return base_executable, child_env


class ProcessTree:
    @classmethod
    def for_subprocess(cls, process):
        if os.name != "nt":
            return cls(process.pid)
        # Keep the original Popen alive while assigning its exact process handle.
        # Opening by PID here could select a different process after early exit.
        transport = getattr(process, "_transport", None)
        popen = transport.get_extra_info("subprocess") if transport else None
        handle = getattr(popen, "_handle", None)
        if handle is None:
            raise OSError("ASTRBOT_PROCESS_TREE_UNAVAILABLE")
        return cls(process.pid, process_handle=int(handle))

    def __init__(self, pid: int, *, process_handle: int | None = None):
        self.pid = pid
        self.job = None
        self.api = None
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                        ("flags", wintypes.DWORD), ("min_working_set", ctypes.c_size_t),
                        ("max_working_set", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                        ("scheduling", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("basic", BasicLimits), ("io", IoCounters),
                        ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                        ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]

        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        api.CreateJobObjectW.restype = wintypes.HANDLE
        api.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        api.SetInformationJobObject.restype = wintypes.BOOL
        api.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        api.OpenProcess.restype = wintypes.HANDLE
        api.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        api.AssignProcessToJobObject.restype = wintypes.BOOL
        api.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        api.CloseHandle.argtypes = (wintypes.HANDLE,)
        job = api.CreateJobObjectW(None, None)
        process = None
        try:
            if not job:
                raise OSError("ASTRBOT_PROCESS_TREE_UNAVAILABLE")
            limits = ExtendedLimits()
            limits.basic.flags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not api.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise OSError("ASTRBOT_PROCESS_TREE_UNAVAILABLE")
            process = process_handle if process_handle is not None else api.OpenProcess(0x0100 | 0x0001, False, pid)
            if not process or not api.AssignProcessToJobObject(job, process):
                raise OSError("ASTRBOT_PROCESS_TREE_UNAVAILABLE")
            self.api, self.job = api, job
        except BaseException:
            if job:
                api.CloseHandle(job)
            raise
        finally:
            if process and process_handle is None:
                api.CloseHandle(process)

    def close(self):
        if self.job:
            self.api.TerminateJobObject(self.job, 1)
            self.api.CloseHandle(self.job)
            self.job = None
        elif os.name != "nt":
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
