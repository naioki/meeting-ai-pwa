import base64
encoded = b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
with open("icon.png", "wb") as f:
    f.write(base64.b64decode(encoded))
print("Saved 1x1 icon.")
