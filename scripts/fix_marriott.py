#!/usr/bin/env python3
"""
v1.0.1: Replace the three Marriott personal candidates
(Brilliant, Boundless, Bevy) with the actual card the user has:
the legacy Chase Marriott Rewards Premier Visa ($85 AF, closed to new
applicants, still supported for existing cardmembers).

Marriott Bonvoy Business (Amex, $125) is untouched.
"""
from __future__ import annotations
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "electron" / "benefitsSeedData.ts"
src = SEED.read_text()

# --------------------------------------------------------------------------
# 1. Remove the three wrong Marriott personal card rows.
# --------------------------------------------------------------------------
CARD_RE = re.compile(
    r'^  \{ id: "marriott_personal__(?:brilliant|boundless|bevy)",[^\n]*\},\n',
    re.MULTILINE,
)
n_cards = len(CARD_RE.findall(src))
assert n_cards == 3, f"expected 3 marriott_personal__ cards to remove, found {n_cards}"

# Replace the FIRST wrong card row with the new Premier card row.
NEW_CARD = (
    '  { id: "marriott_premier", name: "Marriott Rewards Premier Card (legacy Chase)", '
    'issuer: "Chase", network: "Visa Signature", annual_fee_usd: 85, '
    'source_url: "https://marriott.chase.com/premier", '
    'notes: "Legacy card issued by Chase, closed to new applicants since 2018. '
    'Existing cardmembers retain original benefits." },\n'
)
src, first_replaced = CARD_RE.subn(NEW_CARD, src, count=1)
assert first_replaced == 1
# Delete the remaining two.
src, remaining_replaced = CARD_RE.subn("", src)
assert remaining_replaced == 2

# --------------------------------------------------------------------------
# 2. Remove all benefit rows attached to the three wrong cards.
# --------------------------------------------------------------------------
BENEFIT_RE = re.compile(
    r'^  \{ card_id: "marriott_personal__(?:brilliant|boundless|bevy)",[^\n]*\},\n',
    re.MULTILINE,
)
n_benefits = len(BENEFIT_RE.findall(src))
print(f"Removing {n_benefits} benefits attached to the 3 wrong Marriott cards.")
src = BENEFIT_RE.sub("", src)

# --------------------------------------------------------------------------
# 3. Insert benefits for the new Marriott Rewards Premier card.
#    Insert right after the last remaining Marriott (non-Premier) benefit,
#    or immediately before the closing `];` of GENERATED_BENEFITS.
#    Simpler: append just before `];\n` of the benefits array.
# --------------------------------------------------------------------------
SRC_URL = "https://marriott.chase.com/premier"
new_benefits = [
    # Earning multipliers (unlimited)
    f'  {{ card_id: "marriott_premier", program_id: null, title: "5x Marriott Bonvoy points at Marriott properties", description: "Earn 5 points per $1 spent at over 30 hotel brands participating in Marriott Bonvoy.", category: "earning_multiplier", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 5, source_url: "{SRC_URL}" }},',
    f'  {{ card_id: "marriott_premier", program_id: null, title: "2x Marriott Bonvoy points on airfare, car rentals & dining", description: "Earn 2 points per $1 spent on airline tickets purchased directly with the airline, at car rental agencies, and at restaurants.", category: "earning_multiplier", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 6, source_url: "{SRC_URL}" }},',
    f'  {{ card_id: "marriott_premier", program_id: null, title: "1x Marriott Bonvoy points on everything else", description: "Earn 1 point per $1 spent on all other purchases.", category: "earning_multiplier", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 7, source_url: "{SRC_URL}" }},',
    # Annual free night award (up to 25k points, 12-month expiry)
    f'  {{ card_id: "marriott_premier", program_id: null, title: "Anniversary Free Night Award (up to 25,000 points)", description: "One Free Night Award every year after account anniversary, valid for a one-night stay at a Marriott Bonvoy property with a redemption level up to 25,000 points. May combine with up to 25,000 additional points to reach higher categories.", category: "free_night", reset_cadence: "annual", uses_per_period: 1, value_usd: 175, expiration_note: "Certificate expires 12 months from issuance.", sort_order: 10, source_url: "{SRC_URL}", notes: "Value estimated from typical mid-tier Marriott nightly rate; actual value varies by property. Awarded ~8 weeks after account anniversary." }},',
    # 15 Elite Night Credits per calendar year (annual, effectively toggle)
    f'  {{ card_id: "marriott_premier", program_id: null, title: "15 Elite Night Credits (annual)", description: "15 Elite Night Credits deposited each calendar year toward the next level of Marriott Bonvoy Elite status. Deposited on or before March 1.", category: "status_boost", reset_cadence: "annual", uses_per_period: 1, value_usd: 0, expiration_note: "Not exclusive to Chase; maximum one 15-ENC benefit per Marriott Bonvoy consumer card per year (business cards can stack for a second 15-ENC).", sort_order: 20, source_url: "{SRC_URL}", notes: "Deposits automatically; no user action required. Marking used simply records that this year\'s deposit happened." }},',
    # 1 Elite Night Credit per $3,000 spend, no cap - modeled as monthly to allow multiple in year
    f'  {{ card_id: "marriott_premier", program_id: null, title: "1 Elite Night Credit per $3,000 spent (uncapped)", description: "Earn 1 Elite Night Credit toward Marriott Bonvoy Elite status for every $3,000 in purchases, with no cap on the number of credits earned.", category: "status_boost", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, spend_threshold_usd: 3000, expiration_note: "No cap. Elite nights credited within ~8 weeks after month qualified.", sort_order: 25, source_url: "{SRC_URL}" }},',
    # Automatic Silver status - unlimited/ongoing
    f'  {{ card_id: "marriott_premier", program_id: null, title: "Automatic Marriott Bonvoy Silver Elite status", description: "Complimentary Marriott Bonvoy Silver Elite status for as long as the account is open.", category: "status_boost", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 30, source_url: "{SRC_URL}" }},',
    # No foreign transaction fees - unlimited
    f'  {{ card_id: "marriott_premier", program_id: null, title: "No Foreign Transaction Fees", description: "No foreign transaction fees on international purchases.", category: "other", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 40, source_url: "{SRC_URL}" }},',
    # Trip cancellation/interruption insurance - unique to legacy Premier
    f'  {{ card_id: "marriott_premier", program_id: null, title: "Trip Cancellation / Interruption Insurance", description: "Reimbursement for prepaid non-refundable travel expenses if a trip is canceled or interrupted for covered reasons. This is a legacy Premier benefit not carried forward to Boundless.", category: "other", reset_cadence: "unlimited", uses_per_period: null, value_usd: 0, expiration_note: "n.a.", sort_order: 50, source_url: "{SRC_URL}" }},',
    # Refer a friend (5k pts per approved, capped at 10/year = 50k)
    f'  {{ card_id: "marriott_premier", program_id: null, title: "Refer-a-friend bonus (5,000 pts per approved, capped at 10)", description: "Earn 5,000 Marriott Bonvoy points for each friend approved for a Marriott Bonvoy Credit Card from Chase, up to 50,000 points per calendar year (10 approved referrals).", category: "other", reset_cadence: "annual", uses_per_period: 10, value_usd: 40, expiration_note: "Per calendar year.", sort_order: 60, source_url: "{SRC_URL}", notes: "Value per approved referral estimated at ~$40 (5,000 pts × ~0.8 cents)." }},',
]
new_block = "\n".join(new_benefits) + "\n"

# Insert immediately before the closing `];` of the GENERATED_BENEFITS array.
# Match the FIRST occurrence of `\n];\n` after `GENERATED_BENEFITS`.
close_re = re.compile(r'(export const GENERATED_BENEFITS[^;]*?)(\n\];)', re.DOTALL)
m = close_re.search(src)
assert m, "could not locate end of GENERATED_BENEFITS array"
src = src[:m.end(1)] + "\n" + new_block + src[m.end(1)+1:]  # +1 to consume the leading \n

# --------------------------------------------------------------------------
# 4. Refresh header comment to reflect the resolved Marriott identity.
# --------------------------------------------------------------------------
src = re.sub(
    r"//   • The user's 'Marriott premier' card is ambiguous\. Three candidates are included as separate card entries with ids marriott_personal__brilliant, marriott_personal__boundless and marriott_personal__bevy so the app can present a choice\.\n",
    "//   • Marriott personal card: the legacy Chase Marriott Rewards Premier Visa ($85 AF, closed to new applicants since 2018). The user separately holds the Marriott Bonvoy Business (Amex, $125 AF).\n",
    src,
)

SEED.write_text(src)
print("Wrote", SEED)
