#!/usr/bin/env python3
import json, re, sys
from datetime import datetime, timezone

raw_file = sys.argv[1]
output_file = sys.argv[2]

with open(raw_file) as f:
    raw = f.read()

ansi_re = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07')
clean = ansi_re.sub('', raw)

data = {
    "scraped_at": datetime.now(timezone.utc).isoformat(),
    "session": None,
    "weekly_all": None,
    "weekly_sonnet": None,
    "extra_usage": None,
}

lines = [l.strip() for l in clean.split('\n') if l.strip()]

i = 0
while i < len(lines):
    line = lines[i]
    lower = line.lower()
    
    # Look for section headers followed by progress bar + percentage
    pct_line = lines[i+1] if i+1 < len(lines) else ""
    reset_line = lines[i+2] if i+2 < len(lines) else ""
    
    pct_match = re.search(r'(\d+(?:\.\d+)?)\s*%\s*used', pct_line)
    reset_match = re.search(r'[Rr]esets?\s+(.+?)$', reset_line)
    
    if 'current session' in lower and pct_match:
        data['session'] = {
            'percent': float(pct_match.group(1)),
            'resets': reset_match.group(1).strip() if reset_match else None
        }
    elif 'current week' in lower and 'all model' in lower and pct_match:
        data['weekly_all'] = {
            'percent': float(pct_match.group(1)),
            'resets': reset_match.group(1).strip() if reset_match else None
        }
    elif 'current week' in lower and 'sonnet' in lower and pct_match:
        data['weekly_sonnet'] = {
            'percent': float(pct_match.group(1)),
            'resets': reset_match.group(1).strip() if reset_match else None
        }
    elif 'extra usage' in lower:
        next_line = lines[i+1] if i+1 < len(lines) else ""
        if 'not enabled' in next_line.lower() or '$' in next_line:
            data['extra_usage'] = next_line.strip()
    
    i += 1

with open(output_file, 'w') as f:
    json.dump(data, f, indent=2)

print(json.dumps(data, indent=2))
