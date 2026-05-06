import argparse
import json
import sys
import time
from datetime import UTC, datetime
from typing import Any, Dict, List, Optional

from pyrekordbox import Rekordbox6Database
from sqlalchemy import text


def emit(packet: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(packet, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def normalize_bpm(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        bpm = float(value)
    except (TypeError, ValueError):
        return None
    if bpm > 500:
        bpm = bpm / 100.0
    return round(bpm, 2)


def as_list(result: Any) -> List[Any]:
    if result is None:
        return []
    if isinstance(result, list):
        return result
    if isinstance(result, tuple):
        return list(result)
    return [result]


def pick_datetime(*values: Any) -> Optional[datetime]:
    for value in values:
        if isinstance(value, datetime):
            return value
    return None


def parse_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    if value is None:
        return None
    text_value = str(value).strip()
    if not text_value:
        return None
    for candidate in (text_value, text_value.replace("Z", "+00:00")):
        try:
            return datetime.fromisoformat(candidate)
        except ValueError:
            continue
    return None


def safe_artist_name(content: Any) -> Optional[str]:
    artist = getattr(content, "Artist", None)
    if artist is not None:
        artist_name = getattr(artist, "Name", None)
        if artist_name:
            return str(artist_name)
    fallback = getattr(content, "SrcArtistName", None)
    return str(fallback) if fallback else None


def get_latest_history_snapshot_sql(
    db: Rekordbox6Database, history_offset_seconds: int
) -> Optional[Dict[str, Any]]:
    session = getattr(db, "session", None)
    if session is None:
        return None
    rows = session.execute(
        text(
            """
            SELECT
              h.ID AS history_id,
              h.DateCreated AS history_date,
              sh.TrackNo AS track_no,
              sh.ContentID AS content_id,
              sh.created_at AS song_created_at,
              sh.updated_at AS song_updated_at,
              c.Title AS title,
              c.BPM AS bpm,
              c.Length AS length_sec,
              a.Name AS artist_name,
              c.SrcArtistName AS src_artist_name
            FROM djmdHistory h
            JOIN djmdSongHistory sh ON sh.HistoryID = h.ID
            LEFT JOIN djmdContent c ON c.ID = sh.ContentID
            LEFT JOIN djmdArtist a ON a.ID = c.ArtistID
            WHERE IFNULL(h.rb_local_deleted, 0) = 0
              AND IFNULL(sh.rb_local_deleted, 0) = 0
            ORDER BY datetime(h.DateCreated) DESC, CAST(sh.TrackNo AS INTEGER) DESC, sh.updated_at DESC
            LIMIT 80
            """
        )
    ).fetchall()
    if not rows:
        return None

    grouped: Dict[str, List[Any]] = {}
    for row in rows:
        history_id = str(row.history_id) if row.history_id is not None else ""
        if not history_id:
            continue
        grouped.setdefault(history_id, []).append(row)
    if not grouped:
        return None

    selected_rows: List[Any] = []
    for _, history_rows in grouped.items():
        with_content = [r for r in history_rows if r.title]
        if with_content:
            selected_rows = with_content
            break
    if not selected_rows:
        selected_rows = next(iter(grouped.values()))

    def row_to_track(row: Any) -> Dict[str, Any]:
        detected = (
            parse_datetime(row.song_updated_at)
            or parse_datetime(row.song_created_at)
            or parse_datetime(row.history_date)
        )
        artist_name = row.artist_name or row.src_artist_name
        return {
            "contentId": row.content_id,
            "title": row.title,
            "artist": str(artist_name) if artist_name else None,
            "trackBpm": normalize_bpm(row.bpm),
            "durationSec": int(row.length_sec or 0) or None,
            "trackNo": int(row.track_no or 0) or None,
            "detectedAt": detected.isoformat() if detected else None,
            "source": "rekordbox-history",
        }

    recent_tracks = [row_to_track(row) for row in selected_rows[:2]]
    now_playing = recent_tracks[0] if recent_tracks else None
    duration_sec = now_playing.get("durationSec") if now_playing else None
    detected_at = parse_datetime(now_playing.get("detectedAt")) if now_playing else None

    estimated_position = None
    if detected_at:
        now = datetime.now(detected_at.tzinfo) if detected_at.tzinfo else datetime.now()
        elapsed = max(0, (now - detected_at).total_seconds())
        estimated_position = elapsed + max(0, history_offset_seconds)
        if duration_sec is not None:
            estimated_position = min(float(duration_sec), float(estimated_position))

    remaining_sec = None
    if duration_sec is not None and estimated_position is not None:
        remaining_sec = max(0.0, float(duration_sec) - float(estimated_position))

    return {
        "nowPlaying": now_playing,
        "recentTracks": recent_tracks,
        "playback": {
            "positionSec": round(estimated_position, 2) if estimated_position is not None else None,
            "remainingSec": round(remaining_sec, 2) if remaining_sec is not None else None,
            "isEstimated": True,
            "isPlaying": None,
            "updatedAt": utc_now_iso(),
        },
        "capabilities": {
            "nowPlayingSource": "rekordbox-history",
            "playheadSource": "estimated-from-history",
        },
        "warnings": [
            "Now Playingは履歴ベースのため、Rekordboxの記録タイミング次第で反映遅延が発生します。"
        ],
    }


def open_db(args: argparse.Namespace) -> Rekordbox6Database:
    kwargs: Dict[str, Any] = {}
    if args.db_path:
        kwargs["path"] = args.db_path
    if args.db_dir:
        kwargs["db_dir"] = args.db_dir
    if args.db_key:
        kwargs["key"] = args.db_key
    return Rekordbox6Database(**kwargs)


def get_latest_history_snapshot(
    db: Rekordbox6Database, history_offset_seconds: int
) -> Dict[str, Any]:
    sql_snapshot = get_latest_history_snapshot_sql(db, history_offset_seconds)
    if sql_snapshot is not None:
        return sql_snapshot

    if hasattr(db, "session") and hasattr(db.session, "expire_all"):
        db.session.expire_all()

    histories = as_list(db.get_history())
    if not histories:
        return {
            "nowPlaying": None,
            "playback": {
                "positionSec": None,
                "remainingSec": None,
                "isEstimated": True,
                "isPlaying": None,
                "updatedAt": utc_now_iso(),
            },
            "capabilities": {
                "nowPlayingSource": "rekordbox-history",
                "playheadSource": "estimated-from-history",
            },
            "warnings": ["History playlist is empty. Start playback in Rekordbox first."],
        }

    latest_history = None
    latest_songs: List[Any] = []
    latest_dt: Optional[datetime] = None
    for history in histories:
        songs = as_list(db.get_history_songs(HistoryID=getattr(history, "ID", None)))
        if not songs:
            continue
        history_dt = pick_datetime(
            getattr(history, "DateCreated", None),
            getattr(history, "created_at", None),
            getattr(history, "updated_at", None),
        ) or datetime.min
        if latest_history is None or history_dt > (latest_dt or datetime.min):
            latest_history = history
            latest_songs = songs
            latest_dt = history_dt

    if latest_history is None or not latest_songs:
        return {
            "nowPlaying": None,
            "recentTracks": [],
            "playback": {
                "positionSec": None,
                "remainingSec": None,
                "isEstimated": True,
                "isPlaying": None,
                "updatedAt": utc_now_iso(),
            },
            "capabilities": {
                "nowPlayingSource": "rekordbox-history",
                "playheadSource": "estimated-from-history",
            },
            "warnings": ["History exists but no songs were found in it."],
        }

    songs_sorted = sorted(
        latest_songs,
        key=lambda s: (
            int(getattr(s, "TrackNo", 0) or 0),
            pick_datetime(getattr(s, "created_at", None), getattr(s, "updated_at", None))
            or datetime.min,
        ),
    )
    latest_song = songs_sorted[-1]

    def build_recent_tracks(song_items: List[Any], history_item: Any) -> List[Dict[str, Any]]:
        tracks: List[Dict[str, Any]] = []
        for song in reversed(song_items[-2:]):
            content_results = as_list(db.get_content(ID=getattr(song, "ContentID", None)))
            content_row = content_results[0] if content_results else None
            if content_row is None:
                continue
            detected = pick_datetime(
                getattr(song, "created_at", None), getattr(song, "updated_at", None)
            ) or pick_datetime(getattr(history_item, "DateCreated", None))
            tracks.append(
                {
                    "contentId": getattr(content_row, "ID", None),
                    "title": getattr(content_row, "Title", None),
                    "artist": safe_artist_name(content_row),
                    "trackBpm": normalize_bpm(getattr(content_row, "BPM", None)),
                    "durationSec": int(getattr(content_row, "Length", 0) or 0) or None,
                    "trackNo": int(getattr(song, "TrackNo", 0) or 0) or None,
                    "detectedAt": detected.isoformat() if detected else None,
                    "source": "rekordbox-history",
                }
            )
        return tracks

    recent_tracks: List[Dict[str, Any]] = build_recent_tracks(songs_sorted, latest_history)
    if not recent_tracks:
        histories_sorted = sorted(
            histories,
            key=lambda h: pick_datetime(
                getattr(h, "DateCreated", None),
                getattr(h, "created_at", None),
                getattr(h, "updated_at", None),
            )
            or datetime.min,
            reverse=True,
        )
        for candidate in histories_sorted:
            if getattr(candidate, "ID", None) == getattr(latest_history, "ID", None):
                continue
            candidate_songs = as_list(db.get_history_songs(HistoryID=getattr(candidate, "ID", None)))
            if not candidate_songs:
                continue
            candidate_sorted = sorted(
                candidate_songs,
                key=lambda s: (
                    int(getattr(s, "TrackNo", 0) or 0),
                    pick_datetime(getattr(s, "created_at", None), getattr(s, "updated_at", None))
                    or datetime.min,
                ),
            )
            candidate_tracks = build_recent_tracks(candidate_sorted, candidate)
            if candidate_tracks:
                latest_history = candidate
                songs_sorted = candidate_sorted
                latest_song = candidate_sorted[-1]
                recent_tracks = candidate_tracks
                break

    now_playing = recent_tracks[0] if recent_tracks else None
    content = None
    if now_playing:
        content_results = as_list(db.get_content(ID=now_playing.get("contentId")))
        content = content_results[0] if content_results else None
    if content is None:
        content_results = as_list(db.get_content(ID=getattr(latest_song, "ContentID", None)))
        content = content_results[0] if content_results else None

    if content is None and not recent_tracks:
        return {
            "nowPlaying": None,
            "recentTracks": [],
            "playback": {
                "positionSec": None,
                "remainingSec": None,
                "isEstimated": True,
                "isPlaying": None,
                "updatedAt": utc_now_iso(),
            },
            "capabilities": {
                "nowPlayingSource": "rekordbox-history",
                "playheadSource": "estimated-from-history",
            },
            "warnings": ["Latest history entries have no matching content rows."],
        }

    duration_sec = int(getattr(content, "Length", 0) or 0) or (
        now_playing.get("durationSec") if now_playing else None
    )
    detected_at = pick_datetime(
        getattr(latest_song, "created_at", None),
        getattr(latest_song, "updated_at", None),
        getattr(latest_history, "DateCreated", None),
    )

    estimated_position = None
    if detected_at:
        now = datetime.now(detected_at.tzinfo) if detected_at.tzinfo else datetime.now()
        elapsed = max(0, (now - detected_at).total_seconds())
        estimated_position = elapsed + max(0, history_offset_seconds)

    if duration_sec is not None and estimated_position is not None:
        estimated_position = min(float(duration_sec), float(estimated_position))

    remaining_sec = None
    if duration_sec is not None and estimated_position is not None:
        remaining_sec = max(0.0, float(duration_sec) - float(estimated_position))

    if now_playing is None:
        now_playing = {
            "contentId": getattr(content, "ID", None),
            "title": getattr(content, "Title", None),
            "artist": safe_artist_name(content),
            "trackBpm": normalize_bpm(getattr(content, "BPM", None)),
            "durationSec": duration_sec,
            "detectedAt": detected_at.isoformat() if detected_at else None,
            "source": "rekordbox-history",
        }

    playback = {
        "positionSec": round(estimated_position, 2) if estimated_position is not None else None,
        "remainingSec": round(remaining_sec, 2) if remaining_sec is not None else None,
        "isEstimated": True,
        "isPlaying": None,
        "updatedAt": utc_now_iso(),
    }

    return {
        "nowPlaying": now_playing,
        "recentTracks": recent_tracks,
        "playback": playback,
        "capabilities": {
            "nowPlayingSource": "rekordbox-history",
            "playheadSource": "estimated-from-history",
        },
        "warnings": [
            "Now Playingは履歴ベースのため、Rekordboxの記録タイミング次第で反映遅延が発生します。"
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rekordbox bridge stream")
    parser.add_argument("--poll-ms", type=int, default=500)
    parser.add_argument("--db-path", type=str, default="")
    parser.add_argument("--db-dir", type=str, default="")
    parser.add_argument("--db-key", type=str, default="")
    parser.add_argument("--history-offset-seconds", type=int, default=60)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db: Optional[Rekordbox6Database] = None
    last_snapshot_fingerprint = ""

    emit({"type": "status", "ok": True, "message": "Bridge booting"})
    while True:
        try:
            if db is None:
                db = open_db(args)
                emit(
                    {
                        "type": "status",
                        "ok": True,
                        "message": "Connected to Rekordbox database",
                    }
                )

            snapshot = get_latest_history_snapshot(db, args.history_offset_seconds)
            comparable = {
                "nowPlaying": snapshot.get("nowPlaying"),
                "recentTracks": snapshot.get("recentTracks", []),
                "playback": {
                    "positionSec": snapshot.get("playback", {}).get("positionSec"),
                    "remainingSec": snapshot.get("playback", {}).get("remainingSec"),
                    "isEstimated": snapshot.get("playback", {}).get("isEstimated"),
                    "isPlaying": snapshot.get("playback", {}).get("isPlaying"),
                },
                "capabilities": snapshot.get("capabilities"),
                "warnings": snapshot.get("warnings"),
            }
            fingerprint = json.dumps(comparable, sort_keys=True, ensure_ascii=False)
            if fingerprint != last_snapshot_fingerprint:
                emit({"type": "snapshot", "payload": snapshot})
                last_snapshot_fingerprint = fingerprint
            time.sleep(max(0.05, args.poll_ms / 1000.0))
        except KeyboardInterrupt:
            break
        except Exception as exc:
            emit(
                {
                    "type": "status",
                    "ok": False,
                    "message": f"Rekordbox bridge error: {exc}",
                }
            )
            try:
                if db is not None:
                    db.close()
            except Exception:
                pass
            db = None
            time.sleep(2.0)

    try:
        if db is not None:
            db.close()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
