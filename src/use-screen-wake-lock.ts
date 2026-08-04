import { useCallback, useEffect, useRef } from "react";

export function useScreenWakeLock() {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const desiredRef = useRef(false);

  const requestScreenWakeLock = useCallback(async () => {
    desiredRef.current = true;
    if (document.visibilityState !== "visible") return false;
    if (sentinelRef.current && !sentinelRef.current.released) return true;

    if (!("wakeLock" in navigator)) return false;

    try {
      const sentinel = await navigator.wakeLock.request("screen");
      sentinelRef.current = sentinel;
      sentinel.addEventListener("release", () => {
        if (sentinelRef.current === sentinel) sentinelRef.current = null;
      });
      return true;
    } catch {
      return false;
    }
  }, []);

  const releaseScreenWakeLock = useCallback(async () => {
    desiredRef.current = false;
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    if (sentinel && !sentinel.released) {
      await sentinel.release().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && desiredRef.current) {
        void requestScreenWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [requestScreenWakeLock]);

  useEffect(() => () => {
    desiredRef.current = false;
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    if (sentinel && !sentinel.released) void sentinel.release();
  }, []);

  return { releaseScreenWakeLock, requestScreenWakeLock };
}
