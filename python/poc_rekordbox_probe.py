import json
from datetime import datetime
from typing import Any, Dict, List

from pyrekordbox import Rekordbox6Database, show_config


def as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def dt_or_none(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return ""


def main() -> int:
    report: Dict[str, Any] = {
        "ok": False,
        "capabilities": {
            "nowPlayingSource": "unknown",
            "playheadSource": "unknown",
            "realtimeBpmSource": "ableton-link-required",
        },
        "notes": [
            "FLX10ではPRO DJ LINK取得は不可。BPMはAbleton Link経由で別取得が必要。",
            "master.db起点のNow Playingは履歴ベースになる可能性があり、反映遅延が発生し得ます。",
        ],
    }

    try:
        show_config()
    except Exception:
        pass

    try:
        db = Rekordbox6Database()
    except Exception as exc:
        report["error"] = f"DB open failed: {exc}"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1

    try:
        histories = as_list(db.get_history())
        report["historyCount"] = len(histories)

        latest_history = None
        if histories:
            latest_history = max(
                histories,
                key=lambda h: getattr(h, "DateCreated", None)
                or getattr(h, "created_at", None)
                or datetime.min,
            )
            report["latestHistoryId"] = getattr(latest_history, "ID", None)
            report["latestHistoryDate"] = dt_or_none(getattr(latest_history, "DateCreated", None))

        latest_song = None
        if latest_history:
            songs = as_list(db.get_history_songs(HistoryID=getattr(latest_history, "ID", None)))
            report["latestHistorySongCount"] = len(songs)
            if songs:
                latest_song = max(songs, key=lambda s: int(getattr(s, "TrackNo", 0) or 0))

        latest_content = None
        if latest_song:
            content = as_list(db.get_content(ID=getattr(latest_song, "ContentID", None)))
            latest_content = content[0] if content else None

        registries = as_list(db.get_agent_registry())
        registry_keys = [str(getattr(r, "registry_id", "")) for r in registries if getattr(r, "registry_id", "")]
        playback_related = [
            key
            for key in registry_keys
            if any(token in key.lower() for token in ("play", "deck", "track", "tempo", "bpm"))
        ]

        report["agentRegistryCount"] = len(registry_keys)
        report["playbackLikeRegistryKeys"] = playback_related[:50]

        report["ok"] = True
        report["latestHistoryTrackTitle"] = getattr(latest_content, "Title", None) if latest_content else None
        report["latestHistoryTrackArtist"] = (
            getattr(getattr(latest_content, "Artist", None), "Name", None) if latest_content else None
        )

        report["capabilities"]["nowPlayingSource"] = "rekordbox-history" if latest_content else "unavailable"
        report["capabilities"]["playheadSource"] = "estimated-from-history" if latest_content else "unavailable"
    finally:
        try:
            db.close()
        except Exception:
            pass

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
