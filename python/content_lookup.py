import argparse
import json
import sys
from typing import Any, Dict

from pyrekordbox import Rekordbox6Database
from sqlalchemy import text


def normalize_bpm(value: Any) -> float | None:
    if value is None:
        return None
    try:
        bpm = float(value)
    except (TypeError, ValueError):
        return None
    if bpm > 500:
        bpm = bpm / 100.0
    return round(bpm, 2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Lookup Rekordbox content metadata by content ID")
    parser.add_argument("--content-id", default="")
    parser.add_argument("--track-bpm", type=float, default=None)
    parser.add_argument("--duration-sec", type=float, default=None)
    parser.add_argument("--db-path", default="")
    parser.add_argument("--db-dir", default="")
    parser.add_argument("--db-key", default="")
    return parser.parse_args()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    kwargs: Dict[str, Any] = {}
    if args.db_path:
        kwargs["path"] = args.db_path
    if args.db_dir:
        kwargs["db_dir"] = args.db_dir
    if args.db_key:
        kwargs["key"] = args.db_key

    with Rekordbox6Database(**kwargs) as db:
        row = None
        if args.content_id:
            row = db.session.execute(
                text(
                    """
                    SELECT
                      c.ID AS content_id,
                      c.Title AS title,
                      a.Name AS artist_name,
                      c.SrcArtistName AS src_artist_name,
                      c.BPM AS bpm,
                      c.Length AS length_sec,
                      c.TrackNo AS track_no
                    FROM djmdContent c
                    LEFT JOIN djmdArtist a ON a.ID = c.ArtistID
                    WHERE c.ID = :content_id
                    LIMIT 1
                    """
                ),
                {"content_id": str(args.content_id)},
            ).fetchone()

        if row is None and args.track_bpm is not None and args.duration_sec is not None:
            candidates = db.session.execute(
                text(
                    """
                    SELECT
                      c.ID AS content_id,
                      c.Title AS title,
                      a.Name AS artist_name,
                      c.SrcArtistName AS src_artist_name,
                      c.BPM AS bpm,
                      c.Length AS length_sec,
                      c.TrackNo AS track_no
                    FROM djmdContent c
                    LEFT JOIN djmdArtist a ON a.ID = c.ArtistID
                    WHERE c.Length IS NOT NULL
                    """
                )
            ).fetchall()
            scored = []
            for item in candidates:
                item_bpm = normalize_bpm(item.bpm)
                item_len = float(item.length_sec or 0)
                if item_bpm is None or item_len <= 0:
                    continue
                bpm_delta = abs(item_bpm - float(args.track_bpm))
                len_delta = abs(item_len - float(args.duration_sec))
                if len_delta > 1.5:
                    continue
                scored.append((len_delta + (bpm_delta / 10.0), item))
            scored.sort(key=lambda x: x[0])
            if len(scored) == 1:
                row = scored[0][1]
            elif len(scored) > 1 and (scored[1][0] - scored[0][0]) >= 0.4:
                row = scored[0][1]

    if not row:
        print(
            json.dumps(
                {
                    "ok": False,
                    "contentId": str(args.content_id) if args.content_id else None,
                },
                ensure_ascii=False,
            )
        )
        return 0

    artist = row.artist_name or row.src_artist_name
    print(
        json.dumps(
            {
                "ok": True,
                "contentId": str(row.content_id),
                "title": row.title,
                "artist": str(artist) if artist else None,
                "trackBpm": normalize_bpm(row.bpm),
                "durationSec": int(row.length_sec or 0) or None,
                "trackNo": int(row.track_no or 0) or None,
                "source": "rekordbox-db-live",
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
