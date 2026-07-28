#!/usr/bin/env python3
"""
v1.0.1 corrections to electron/benefitsSeedData.ts:

1. Rewrite the Virgin Atlantic card entry to reflect the LIVE US card
   (Virgin Red Rewards Mastercard, Synchrony Bank, $99 AF).
2. Replace the Virgin Atlantic benefits with the Synchrony card's benefits.
3. Normalize `uses_per_period` + `value_usd` for every `quarterly` benefit so
   that value_usd = per-quarter amount and uses_per_period = 1 (per period).
   This matches the projection engine, which filters usages by current-period
   period_key and computes total_value = uses_max * value_usd.
"""
from __future__ import annotations
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "electron" / "benefitsSeedData.ts"

src = SEED.read_text()

# --------------------------------------------------------------------------
# 1) Replace the virgin_atlantic card row.
# --------------------------------------------------------------------------
OLD_CARD = '  { id: "virgin_atlantic", name: "Virgin Atlantic World Elite Mastercard (Bank of America) — DISCONTINUED; replaced by the Virgin Red Rewards Mastercard (Synchrony)", issuer: "Bank of America (discontinued) / Synchrony Bank (current Virgin Red Rewards Mastercard)", network: "Mastercard", annual_fee_usd: 99, source_url: "https://www.virginatlantic.com/en-US/flying-club/credit-card" },'
NEW_CARD = '  { id: "virgin_atlantic", name: "Virgin Red Rewards Mastercard", issuer: "Synchrony Bank", network: "Mastercard", annual_fee_usd: 99, source_url: "https://www.synchrony.com/partner/virgin-red-rewards-card", notes: "Issued by Synchrony Bank. Replaced the discontinued Bank of America Virgin Atlantic World Elite Mastercard in 2024." },'
assert OLD_CARD in src, "virgin_atlantic card row not found"
src = src.replace(OLD_CARD, NEW_CARD)

# --------------------------------------------------------------------------
# 2) Replace the Virgin Atlantic benefit block (lines 160-168 in original).
# --------------------------------------------------------------------------
# Match every consecutive line that starts a card_id="virgin_atlantic" benefit
VIRGIN_BENEFIT_RE = re.compile(
    r'^  \{ card_id: "virgin_atlantic",[^\n]*\},\n',
    flags=re.MULTILINE,
)
old_block_matches = VIRGIN_BENEFIT_RE.findall(src)
assert len(old_block_matches) == 9, f"expected 9 virgin_atlantic benefit rows, found {len(old_block_matches)}"

# Delete them all first, in place.
first_match = VIRGIN_BENEFIT_RE.search(src)
last_match = None
for m in VIRGIN_BENEFIT_RE.finditer(src):
    last_match = m
assert first_match and last_match
block_start = first_match.start()
block_end = last_match.end()
before = src[:block_start]
after = src[block_end:]

# Now construct the new benefits list based on the Synchrony product page.
# Source: https://www.synchrony.com/partner/virgin-red-rewards-card
SRC_URL = "https://www.synchrony.com/partner/virgin-red-rewards-card"
new_benefits = [
    # Earning multipliers — unlimited, unlimited stays
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "3x Virgin Points at Virgin Atlantic, Hotels & Voyages", description: "Earn 3 Virgin Points per $1 spent with Virgin Atlantic, Virgin Hotels and Virgin Voyages.", category: "earning_multiplier", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 5, source_url: "{SRC_URL}" }},',
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "2x Virgin Points on groceries, dining, streaming & EV charging", description: "Earn 2 Virgin Points per $1 at grocery stores, on dining out, on select streaming services, and when charging your EV.", category: "earning_multiplier", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 6, source_url: "{SRC_URL}" }},',
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "1x Virgin Points on everything else", description: "Earn 1 Virgin Point per $1 spent everywhere else Mastercard is accepted.", category: "earning_multiplier", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 7, source_url: "{SRC_URL}" }},',
    # Personal Perks (choice benefit) at $15K / $30K annual spend — one-per-period each
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "1 Personal Perk after $15,000 annual spend", description: "Spend $15,000 in a year to choose one Personal Perk: a Virgin Atlantic reward-flight companion or upgrade voucher, a free Virgin Hotels night or priority suite upgrade, or a $300 Virgin Voyages bar-tab / Blue Extras Perk Package.", category: "other", reset_cadence: "spend_threshold", uses_per_period: 1, value_usd: 300, spend_threshold_usd: 15000, expiration_note: "Per cardmember year.", sort_order: 10, source_url: "{SRC_URL}", notes: "Choice benefit; value varies substantially by which perk is selected." }},',
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "2nd Personal Perk after $30,000 annual spend", description: "Spend $30,000 in a year to choose a second Personal Perk from the same list.", category: "other", reset_cadence: "spend_threshold", uses_per_period: 1, value_usd: 300, spend_threshold_usd: 30000, expiration_note: "Per cardmember year.", sort_order: 20, source_url: "{SRC_URL}" }},',
    # Tier Points on spend — monthly, one bucket per calendar month
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "Tier Points on Spend ($2,500/mo → 25 Tier Points)", description: "Earn 25 Virgin Atlantic Flying Club Tier Points for every $2,500 in qualifying spend per calendar month, capped at 50 Tier Points per month (2 uses).", category: "status_boost", reset_cadence: "monthly", uses_per_period: 2, value_usd: 0, spend_threshold_usd: 2500, expiration_note: "Max 50 Tier Points/month (600/year).", sort_order: 30, source_url: "{SRC_URL}" }},',
    # Anniversary bonus — annual, 5,000 Virgin Points (~$65 at ~1.3 cpp)
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "5,000 Virgin Points Anniversary Bonus", description: "5,000 Virgin Points every year on card renewal, provided the account is open and in good standing.", category: "other", reset_cadence: "annual", uses_per_period: 1, value_usd: 65, expiration_note: "Posts within 1-2 statement periods after renewal.", sort_order: 40, source_url: "{SRC_URL}", notes: "Value estimated at ~1.3 cents per Virgin Point." }},',
    # Third night free at Virgin Hotels — annual
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "Third Night Free at Virgin Hotels", description: "Book two nights at a Virgin Hotel and get the third night free, once per year.", category: "free_night", reset_cadence: "annual", uses_per_period: 1, value_usd: 250, expiration_note: "Once per year.", sort_order: 50, source_url: "{SRC_URL}", notes: "Value estimated from a typical Virgin Hotels nightly rate; not stated on the official page." }},',
    # Add authorized user — one_time, capped at 4 uses (10,000 pts)
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "2,500 Virgin Points per Authorized User (up to 4)", description: "Earn 2,500 Virgin Points each time you add an authorized user, up to 10,000 Virgin Points total (4 users).", category: "other", reset_cadence: "one_time", uses_per_period: 4, value_usd: 130, expiration_note: "Lifetime cap of 10,000 points (4 users).", sort_order: 60, source_url: "{SRC_URL}", notes: "Value estimated at ~1.3 cents per point." }},',
    # No FTFs — unlimited
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "No Foreign Transaction Fees", description: "No foreign transaction fees.", category: "other", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 70, source_url: "{SRC_URL}" }},',
    # Virgin Points don't expire (informational, unlimited)
    f'  {{ card_id: "virgin_atlantic", program_id: null, title: "Virgin Points Never Expire", description: "Virgin Points earned with the card do not expire.", category: "other", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 80, source_url: "{SRC_URL}" }},',
]
new_block = "\n".join(new_benefits) + "\n"
src = before + new_block + after

# --------------------------------------------------------------------------
# 3) Normalize quarterly benefits: value_usd should be per-quarter amount,
#    uses_per_period should be per-quarter (1 use), spend_threshold cleared.
#
#    Convention change: for periodic credits, value_usd is the PER-PERIOD
#    dollar cap and uses_per_period is the PER-PERIOD count. The annual total
#    is emergent (period_count * value_usd). This is what computeProjections
#    already assumes when it filters usages by period_key.
# --------------------------------------------------------------------------
# Match "reset_cadence: \"quarterly\", uses_per_period: 4, value_usd: N" and
# divide N by 4, set uses_per_period to 1.
Q_RE = re.compile(
    r'(reset_cadence: "quarterly", uses_per_period: )4(, value_usd: )(\d+)'
)
def divide_by_4(m):
    total = int(m.group(3))
    per_q = total // 4
    return f'{m.group(1)}1{m.group(2)}{per_q}'
new_src, n_replacements = Q_RE.subn(divide_by_4, src)
print(f"Normalized {n_replacements} quarterly benefit rows to per-period semantics.")
src = new_src

# Sanity check: no more `quarterly", uses_per_period: 4` should remain.
assert '"quarterly", uses_per_period: 4' not in src, "some quarterly rows still use annualized uses_per_period"

# Also patch the header comment to reflect the new convention.
src = src.replace(
    "//   • value_usd figures for statement credits are the stated annual caps. For points-denominated benefits (free nights, upgrade certificates) the value is an explicit estimate documented in the benefit's notes field; where no basis existed, value_usd is 0.",
    "//   • value_usd is the PER-PERIOD dollar cap (e.g. $50 for a quarterly benefit) — the annual total is emergent from cadence × value_usd. Points-denominated benefits use an explicit estimate documented in the notes field; where no basis existed, value_usd is 0."
)
src = src.replace(
    "//   • The Virgin Atlantic World Elite Mastercard from Bank of America was DISCONTINUED in October 2024; existing accounts were converted to the BofA Unlimited Cash Rewards card. The current US Virgin co-brand is the Virgin Red Rewards Mastercard from Synchrony Bank ($99 AF). Benefits listed reflect the current Synchrony card, with legacy BofA spend bonuses flagged.",
    "//   • The Virgin Atlantic co-brand card is the Virgin Red Rewards Mastercard from Synchrony Bank ($99 AF). The old Bank of America Virgin Atlantic World Elite Mastercard was discontinued in October 2024."
)

SEED.write_text(src)
print("Wrote", SEED)
