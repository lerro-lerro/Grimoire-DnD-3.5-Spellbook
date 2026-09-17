"""Converts the imperial units in dndtools texts to metric units, with the rounding used by the
Italian edition of D&D 3.5: 1.5 m for every 5 feet, 0.5 kg per pound, 1.5 km per mile.

    "Close (25 ft. + 5 ft./2 levels)"  -> "Close (7.5 m + 1.5 m/2 levels)"
    "a 10-ft.-radius burst"            -> "a 3-m-radius burst"
    "weighing up to 5 lb."             -> "weighing up to 2.5 kg"
    "1 foot of stone"                  -> "30 cm of stone"

Public functions:
    convert_text(text, is_stat=False) -> text (HTML too) with metric units
    convert_spell(sheet) -> copy of the sheet with converted stats, description and summary

The conversion is idempotent: a converted text no longer contains imperial units.
"""

import re
from decimal import ROUND_HALF_UP, Decimal

# unit -> (quantity, factor to the base metric unit)
FACTORS = {
    "foot": ("length", Decimal("0.3")),      # metres
    "inch": ("length", Decimal("0.025")),
    "yard": ("length", Decimal("0.9")),
    "mile": ("length", Decimal("1500")),
    "sq_foot": ("area", Decimal("0.09")),     # square metres
    "cu_foot": ("volume", Decimal("0.027")),  # cubic metres
    "gallon": ("liquid", Decimal("4")),       # litres
    "quart": ("liquid", Decimal("1")),
    "pint": ("liquid", Decimal("0.5")),
    "pound": ("weight", Decimal("0.5")),      # kilograms
    "ounce": ("weight", Decimal("0.03")),
    "ton": ("weight", Decimal("1000")),
    "mph": ("speed", Decimal("1.5")),         # km/h
}

FEET = r"feet|foot|ft\b\.?|foor"  # "foor": dndtools typo (Caltrops, "5-foot-by-5-foor square")
UNITS = [  # compound forms first ("square feet" before "feet")
    ("sq_foot", rf"(?:square|sq\.)[ -]?(?:{FEET})"),
    ("cu_foot", rf"(?:cubic|cu\.)[ -]?(?:{FEET})"),
    ("foot", FEET),
    ("inch", r"inch(?:es)?|in\.(?=[\s,;)/-])"),
    ("yard", r"yards?|yds?\b\.?"),
    ("mph", r"mph\b"),
    ("mile", r"miles?"),
    ("gallon", r"gallons?"),
    ("quart", r"quarts?"),
    ("pint", r"pints?"),
    ("pound", r"pounds?|lbs?\b\.?"),
    ("ounce", r"ounces?|oz\b\.?"),
    ("ton", r"tons?"),
]

NUMBER_WORDS = {"twenty-five": 25, "five": 5, "ten": 10, "fifteen": 15, "twenty": 20, "thirty": 30,
                "forty": 40, "fifty": 50, "sixty": 60, "eighty": 80}  # "twenty-five" before "twenty"
FRACTIONS = {"½": Decimal("0.5"), "¼": Decimal("0.25"), "¾": Decimal("0.75")}

# 1/2 | 25 | 1,000 | 2.5 | 1-1/2 | 2½ | ½ | ten   (not after letters or digits: "1d4 × 10" converts only the 10)
# the fraction comes first, otherwise NUMBER_RE would find "1" and "2" separately in "1/2"
NUMBER = (r"(?:\d/\d{1,2}(?!\d)|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[ -]\d/\d{1,2}|[½¼¾])?|[½¼¾]"
          rf"|(?i:{'|'.join(NUMBER_WORDS)}))")
SEPARATOR = r"\s*(?:-|–|\bto\b|\bor\b|\band\b|\bby\b|x|×)\s*"  # "5 to 10 feet", "5-by-5 feet"
SPACE = r"(?:\s|&nbsp;|-)?"

UNIT_RE = re.compile(
    rf"(?<![\w.,/])(?P<numbers>{NUMBER}(?:{SEPARATOR}{NUMBER})*)(?P<space>{SPACE})"
    rf"(?P<unit>{'|'.join(f'(?P<{name}>{pattern})' for name, pattern in UNITS)})(?![A-Za-z])", re.I)
NUMBER_RE = re.compile(NUMBER)
# "between –50 and 140 degrees Fahrenheit", "32° F"
FAHRENHEIT_RE = re.compile(
    r"(?<![\w.])(?:(?P<first>[-–−]?\d+)°?(?P<between>\s+(?:and|to)\s+))?(?P<second>[-–−]?\d+)"
    r"(?:\s*°\s*F\b|\s+degrees?\s+(?:Fahrenheit|F\b))")
# dndtools typo (Widen Spell): "40-footradius" -> "40-foot-radius"
GLUED_RE = re.compile(r"(?<=\d-foot)(?=radius|diameter)", re.I)
# "8 pounds per gallon": "per gallon" means "per 1 gallon"
PER_RE = re.compile(r"\bper\s+(?=(?:square\s+|cubic\s+)?(?:foot|inch|yard|mile|gallon|quart|pint|pound|ounce|ton)\b)", re.I)


def _value(text):
    text = text.lower()
    if text in NUMBER_WORDS:
        return Decimal(NUMBER_WORDS[text])
    if text in FRACTIONS:
        return FRACTIONS[text]
    fraction = re.fullmatch(r"(?:(.+?)[ -])?(\d)/(\d{1,2})", text)
    if fraction:
        whole = Decimal(fraction.group(1).replace(",", "")) if fraction.group(1) else Decimal(0)
        return whole + Decimal(fraction.group(2)) / Decimal(fraction.group(3))
    if text[-1] in FRACTIONS:
        return Decimal(text[:-1].replace(",", "")) + FRACTIONS[text[-1]]
    return Decimal(text.replace(",", ""))


def _format(value, decimals=2):
    rounded = value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)
    text = f"{rounded:,f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def _scale(quantity, maximum):
    """Target unit (symbol, divisor, decimals), chosen from the largest value."""
    if quantity == "length":
        if maximum < 1:
            return "cm", Decimal("0.01"), 2
        if maximum >= 1000:
            return "km", Decimal(1000), 2
        return "m", Decimal(1), 2
    if quantity == "weight":
        return ("g", Decimal("0.001"), 0) if maximum < 1 else ("kg", Decimal(1), 2)
    return {"area": ("m²", Decimal(1), 2), "volume": ("m³", Decimal(1), 3),
            "liquid": ("L", Decimal(1), 2), "speed": ("km/h", Decimal(1), 0)}[quantity]


def _convert_measure(match, is_stat):
    name = next(n for n, _ in UNITS if match.group(n))
    quantity, factor = FACTORS[name]
    numbers = list(NUMBER_RE.finditer(match.group("numbers")))
    values = [_value(n.group(0)) * factor for n in numbers]
    symbol, divisor, decimals = _scale(quantity, max(values))
    # the converted numbers replace the original ones, separators ("to", "-by-") unchanged
    text, last = "", 0
    for number, value in zip(numbers, values):
        text += match.group("numbers")[last:number.start()] + _format(value / divisor, decimals)
        last = number.end()
    space = match.group("space") or " "
    # "ft." is an abbreviation: the period stays only if it also ended the sentence
    unit = match.group("unit")
    period = ""
    if unit.endswith("."):
        following = match.string[match.end():]
        if re.match(r"\s+[A-Z]", following) or (not is_stat and re.match(r"\s*(?:</p>|$)", following)):
            period = "."
    return f"{text}{space}{symbol}{period}"


def _fahrenheit(value):
    celsius = (Decimal(value.replace("–", "-").replace("−", "-")) - 32) * 5 / 9
    return _format(celsius, 0)


def _convert_fahrenheit(match):
    if match.group("first"):
        return f"{_fahrenheit(match.group('first'))}{match.group('between')}{_fahrenheit(match.group('second'))} °C"
    return f"{_fahrenheit(match.group('second'))} °C"


def convert_text(text, is_stat=False):
    """Text or HTML with metric measurements. is_stat=True for short values like "60 ft.",
    where the final period only belongs to the abbreviation."""
    if not text:
        return text
    text = FAHRENHEIT_RE.sub(_convert_fahrenheit, text)
    text = GLUED_RE.sub("-", text)
    text = PER_RE.sub(lambda t: f"{t.group(0)}1 ", text)
    return UNIT_RE.sub(lambda t: _convert_measure(t, is_stat), text)


def convert_spell(sheet):
    """Copy of the sheet with stats, description and summary in metric units (the name stays)."""
    result = {**sheet}
    result["stats"] = {key: convert_text(value, is_stat=True)
                       for key, value in (sheet.get("stats") or {}).items()}
    for key in ("description_html", "summary", "description_text"):
        if sheet.get(key):
            result[key] = convert_text(sheet[key])
    return result
