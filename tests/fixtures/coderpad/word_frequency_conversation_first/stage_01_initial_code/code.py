def count_words(sentence):
    counts = {}
    for word in sentence.split(" "):
        counts[word] = counts.get(word, 0) + 1
    return counts

print(count_words("red blue red"))
