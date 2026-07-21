def normalize_name(name):
    limpio = "_".join(name.strip().lower().split())
    return limpio

assert normalize_name(" Ana ") == "ana"
assert normalize_name("Ana   Pérez") == "ana_pérez"
assert normalize_name("") == ""
assert normalize_name("\t Ana\tPérez \n") == "ana_pérez"
print("ok")
