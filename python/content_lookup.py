import argparse
import base64
import json
import os
import struct
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


EXTENDED_SQL = """
    SELECT
      c.ID            AS content_id,
      c.Title         AS title,
      a.Name          AS artist_name,
      c.SrcArtistName AS src_artist_name,
      c.BPM           AS bpm,
      c.Length        AS length_sec,
      c.TrackNo       AS track_no,
      al.Name         AS album_name,
      g.Name          AS genre_name,
      k.ScaleName     AS key_name,
      lb.Name         AS label_name,
      c.Commnt        AS comment,
      c.Subtitle      AS mix_name,
      ra.Name         AS orig_artist_name,
      rm.Name         AS remixer_name,
      cp.Name         AS composer_name,
      c.Lyricist      AS lyricist_name,
      c.AnalysisDataPath AS analysis_path
    FROM djmdContent c
    LEFT JOIN djmdArtist  a  ON a.ID  = c.ArtistID
    LEFT JOIN djmdAlbum   al ON al.ID = c.AlbumID
    LEFT JOIN djmdGenre   g  ON g.ID  = c.GenreID
    LEFT JOIN djmdKey     k  ON k.ID  = c.KeyID
    LEFT JOIN djmdLabel   lb ON lb.ID = c.LabelID
    LEFT JOIN djmdArtist  ra ON ra.ID = c.OrgArtistID
    LEFT JOIN djmdArtist  rm ON rm.ID = c.RemixerID
    LEFT JOIN djmdArtist  cp ON cp.ID = c.ComposerID
"""


def extract_waveform(analysis_rel_path: Any) -> str | None:
    if not analysis_rel_path:
        return None
    try:
        appdata = os.environ.get('APPDATA', '')
        if not appdata:
            return None
        # Replace backslashes/forward slashes uniformly
        rel = str(analysis_rel_path).replace("\\\\", "/").replace("\\", "/").lstrip("/")
        dat_path = os.path.join(appdata, "Pioneer", "rekordbox", "share", *rel.split("/"))
        
        if not os.path.exists(dat_path):
            return None
            
        with open(dat_path, "rb") as f:
            data = f.read()
            if len(data) < 28:
                return None
            h_len = struct.unpack(">I", data[4:8])[0]
            pos = h_len
            while pos < len(data) - 12:
                fourcc = data[pos:pos+4]
                len_hdr = struct.unpack(">I", data[pos+4:pos+8])[0]
                len_total = struct.unpack(">I", data[pos+8:pos+12])[0]
                if len_total == 0 or len_hdr == 0:
                    break
                if fourcc == b"PWAV":
                    body = data[pos+len_hdr : pos+len_total]
                    # PWAV contains 2 byte entries (height, whiteness). We want heights.
                    heights = bytes([body[i] for i in range(0, len(body), 2)])
                    return base64.b64encode(heights).decode("ascii")
                pos += len_total
    except Exception:
        pass
    return None


def row_to_payload(row: Any) -> Dict[str, Any]:
    artist = row.artist_name or row.src_artist_name
    waveform_b64 = extract_waveform(row.analysis_path)
    return {
        "ok": True,
        "contentId": str(row.content_id),
        "title": row.title,
        "artist": str(artist) if artist else None,
        "trackBpm": normalize_bpm(row.bpm),
        "durationSec": int(row.length_sec or 0) or None,
        "trackNo": int(row.track_no or 0) or None,
        "album": str(row.album_name) if row.album_name else None,
        "genre": str(row.genre_name) if row.genre_name else None,
        "key": str(row.key_name) if row.key_name else None,
        "label": str(row.label_name) if row.label_name else None,
        "comment": str(row.comment) if row.comment else None,
        "mixName": str(row.mix_name) if row.mix_name else None,
        "origArtist": str(row.orig_artist_name) if row.orig_artist_name else None,
        "remixer": str(row.remixer_name) if row.remixer_name else None,
        "composer": str(row.composer_name) if row.composer_name else None,
        "lyricist": str(row.lyricist_name) if row.lyricist_name else None,
        "waveform": waveform_b64,
        "source": "rekordbox-db-live",
    }


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
                text(EXTENDED_SQL + "WHERE c.ID = :content_id LIMIT 1"),
                {"content_id": str(args.content_id)},
            ).fetchone()

        if row is None and args.track_bpm is not None and args.duration_sec is not None:
            candidates = db.session.execute(
                text(EXTENDED_SQL + "WHERE c.Length IS NOT NULL")
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

    print(json.dumps(row_to_payload(row), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
