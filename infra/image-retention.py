#!/usr/bin/env python3
"""Project registry image retention. Preview by default; never prune Docker data."""
import argparse
import datetime as dt
import fcntl
import json
import pathlib
import re
import shutil
import subprocess

REPOS = {"ghcr.io/csbpku/deep-research/" + name for name in ("web", "ai-engine")}


def run(*args):
    return subprocess.check_output(args, text=True, timeout=120).strip()


def candidates(images, now):
    rows = []
    for image in images:
        created = dt.datetime.fromisoformat(image["Created"].replace("Z", "+00:00"))
        for ref in image.get("RepoTags") or []:
            repo, tag = ref.rsplit(":", 1)
            # Only immutable commit tags; aliases, custom builds and dangling images stay.
            if repo in REPOS and re.fullmatch(r"[0-9a-f]{7,40}", tag):
                rows.append((repo, ref, image["Id"], created))
    protected = set()
    for repo in REPOS:
        newest = sorted((r for r in rows if r[0] == repo), key=lambda r: r[3], reverse=True)
        # Retain two distinct image versions, including every alias of those IDs.
        ids = list(dict.fromkeys(r[2] for r in newest))[:2]
        protected.update(ids)
    return [r for r in rows if r[2] not in protected and now - r[3] > dt.timedelta(days=14)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--state-dir", type=pathlib.Path, required=True)
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True)
    with (args.state_dir / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ids = run("docker", "image", "ls", "-q", "--no-trunc").splitlines()
        images = []
        for image_id in sorted(set(ids)):
            images.extend(json.loads(run("docker", "image", "inspect", image_id)))
        report = {"time": dt.datetime.now(dt.timezone.utc).isoformat(),
                  "apply": args.apply, "freeBefore": shutil.disk_usage("/").free,
                  "results": []}
        path = args.state_dir / "latest.json"

        def save():
            report["freeAfter"] = shutil.disk_usage("/").free
            temp = path.with_suffix(".tmp")
            temp.write_text(json.dumps(report, indent=2) + "\n")
            temp.replace(path)

        save()
        for _, ref, expected, _ in candidates(images, dt.datetime.now(dt.timezone.utc))[:20]:
            item = {"reference": ref, "id": expected}
            if run("docker", "image", "inspect", "--format", "{{.Id}}", ref) != expected:
                item["status"] = "protected-id-changed"
            elif run("docker", "ps", "-a", "-q", "--filter", "ancestor=" + expected):
                item["status"] = "protected-container-or-descendant"
            elif not args.apply:
                item["status"] = "would-remove"
            else:
                # No force, no parent pruning. Docker also rejects referenced image IDs.
                proc = subprocess.run(["docker", "image", "rm", "--no-prune", ref],
                                      text=True, capture_output=True, timeout=120)
                item.update(status="removed" if proc.returncode == 0 else "docker-refused",
                            output=(proc.stdout + proc.stderr).strip())
            report["results"].append(item)
            save()
        print(json.dumps(report))


if __name__ == "__main__":
    main()
