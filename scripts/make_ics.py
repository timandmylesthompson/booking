"""Builds calendar.ics (the family calendar feed) from the public gig list.
Run by GitHub Actions every hour. Shares only what public_gigs() returns:
dates, show time, venue name, city and state. No fees, contacts or addresses."""
import json, sys, urllib.request, datetime, hashlib

URL = "https://eaguhgotxjdpkvxkuwol.supabase.co/rest/v1/rpc/public_gigs"
KEY = "sb_publishable_4RfoKVn-4ITFLfP1SgGvSw_S9Wxj9Tn"  # public key; the function only returns public fields

EASTERN = "CT DE DC FL GA IN ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV KY".split()
CENTRAL = "AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI".split()
MOUNTAIN = "CO ID MT NM UT WY".split()
TZ = {**{s: "America/New_York" for s in EASTERN}, **{s: "America/Chicago" for s in CENTRAL},
      **{s: "America/Denver" for s in MOUNTAIN}, "AZ": "America/Phoenix", "CA": "America/Los_Angeles",
      "NV": "America/Los_Angeles", "OR": "America/Los_Angeles", "WA": "America/Los_Angeles",
      "AK": "America/Anchorage", "HI": "Pacific/Honolulu"}

def esc(s):
    return str(s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")

def fold(line):
    out, b = [], line.encode()
    while len(b) > 74:
        cut = 74
        while (b[cut] & 0xC0) == 0x80: cut -= 1
        out.append(b[:cut].decode()); b = b" " + b[cut:]
    out.append(b.decode()); return "\r\n".join(out)

def build(gigs):
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tim & Myles Thompson//Gigs//EN", "CALSCALE:GREGORIAN",
         "METHOD:PUBLISH", "X-WR-CALNAME:Tim & Myles Thompson gigs", "X-WR-CALDESC:Where Tim & Myles are playing",
         "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"]
    for g in gigs:
        d = (g.get("date") or "")[:10]
        if not d: continue
        start = datetime.date.fromisoformat(d)
        end = datetime.date.fromisoformat(g["end_date"][:10]) if g.get("end_date") and g["end_date"] > d else start
        where = ", ".join(x for x in [g.get("city"), g.get("state")] if x)
        title = g.get("title") or "Show"
        L += ["BEGIN:VEVENT", f"UID:{g['id']}@timandmylesthompson", f"DTSTAMP:{now}",
              "SUMMARY:" + esc(f"Tim & Myles: {title}" + (f" ({where})" if where else ""))]
        t = g.get("show_time")
        if t and end == start:
            hh, mm = (t.split(":") + ["0"])[:2]
            s = datetime.datetime.combine(start, datetime.time(int(hh), int(mm)))
            e = s + datetime.timedelta(hours=2, minutes=30)
            tz = TZ.get((g.get("state") or "").upper())
            if tz:
                L += [f"DTSTART;TZID={tz}:{s:%Y%m%dT%H%M%S}", f"DTEND;TZID={tz}:{e:%Y%m%dT%H%M%S}"]
            else:
                L += [f"DTSTART:{s:%Y%m%dT%H%M%S}", f"DTEND:{e:%Y%m%dT%H%M%S}"]
        else:
            L += [f"DTSTART;VALUE=DATE:{start:%Y%m%d}", f"DTEND;VALUE=DATE:{end + datetime.timedelta(days=1):%Y%m%d}"]
        if where: L.append("LOCATION:" + esc(f"{title}, {where}" if g.get("kind") != "private" else where))
        desc = [x for x in [g.get("status") and f"Status: {g['status']}", g.get("website")] if x]
        if desc: L.append("DESCRIPTION:" + esc("\n".join(desc)))
        if g.get("website"): L.append("URL:" + g["website"])
        L.append("END:VEVENT")
    L.append("END:VCALENDAR")
    return "\r\n".join(fold(x) for x in L) + "\r\n"

if __name__ == "__main__":
    if len(sys.argv) > 1:
        gigs = json.load(open(sys.argv[1]))
    else:
        req = urllib.request.Request(URL, data=b"{}", method="POST",
              headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        try:
            gigs = json.load(urllib.request.urlopen(req, timeout=30))
        except Exception as e:  # e.g. the database function isn't set up yet: keep the old feed, don't fail
            print("Couldn't read gigs:", e); sys.exit(0)
    open("calendar.ics", "w", newline="").write(build(gigs))
    print(f"{len(gigs)} gigs written")
