def count_words(sentence):
    counts = {}
    for word in sentence.lower().split():
        counts[word] = counts.get(word, 0) + 1
    return list(counts.items())

print(count_words("Red blue red BLUE green"))
