def normalize_name(name):
    limpio = name.strip()
    limpio = limpio.lower()
    limpio = limpio.replace(" ", "_")
    return limpio

print(normalize_name("  Ana   Pérez  "))
