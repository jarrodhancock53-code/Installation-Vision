"""Generate synthetic manuals and photos for the BuildLens end-to-end tests."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(OUT, exist_ok=True)

def font(size):
    for p in ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf']:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def page(title, lines, drawing=None):
    im = Image.new('RGB', (1240, 1754), 'white'); d = ImageDraw.Draw(im)
    d.text((80, 70), title, fill='black', font=font(48))
    y = 170
    for l in lines:
        d.text((80, y), l, fill='black', font=font(30)); y += 50
    if drawing:  # a "step drawing": panel rectangles + an arrow
        x, yy = drawing
        d.rectangle([x, yy, x + 500, yy + 350], outline='black', width=6)
        d.rectangle([x + 60, yy + 60, x + 200, yy + 300], outline='black', width=5)
        d.line([x + 260, yy + 180, x + 440, yy + 180], fill='black', width=6)
        d.polygon([(x + 440, yy + 160), (x + 480, yy + 180), (x + 440, yy + 200)], fill='black')
    return im

def save_pdf(name, pages):
    pages[0].save(os.path.join(OUT, name), save_all=True, append_images=pages[1:], resolution=150)

save_pdf('furniture_manual.pdf', [
    page('KALLBO shelf', ['Parts: A side panel x2, B shelf x1', 'Hardware: 101 cam bolt x4', 'Tool: Allen key']),
    page('Step 1 and 2', ['1. Insert 4 x 101 into A', '2. Attach B to A'], drawing=(300, 500)),
    page('Step 3', ['3. Attach the second A'], drawing=(300, 600)),
])
save_pdf('carseat_manual.pdf', [
    page('SafeRide 360 convertible seat', ['Modes: rear-facing (lower anchors or belt)', 'forward-facing with tether']),
    page('Rear-facing install', ['1. Set recline to position 1-2', '2. Attach lower anchor connectors', '3. Tighten: less than 1 inch movement'], drawing=(300, 700)),
])
save_pdf('big_manual.pdf', [page(f'Page {i+1}', [f'Long manual page {i+1}']) for i in range(45)])
save_pdf('vehicle_section.pdf', [page('Child restraints', ['Tether anchors: rear shelf, behind headrests', 'Lower anchors: outboard seats only'])])

def photo(name, size, items, bg=(92, 84, 76), exif_rotate=False):
    im = Image.new('RGB', size, bg); d = ImageDraw.Draw(im)
    for (x, y, w, h, color, label) in items:
        d.rectangle([x, y, x + w, y + h], fill=color, outline='black', width=8)
        d.text((x + 20, y + 20), label, fill='white', font=font(120))
    path = os.path.join(OUT, name)
    if exif_rotate:
        exif = Image.Exif(); exif[0x0112] = 6  # Orientation: rotate 90 CW to display
        im.save(path, quality=88, exif=exif.tobytes())
    else:
        im.save(path, quality=88)

# 4032x3024 sensor image with EXIF orientation 6 -> displays as 3024x4032 portrait
photo('parts.jpg', (4032, 3024), [(300, 300, 1400, 600, (160, 110, 60), 'A'), (300, 1200, 1400, 600, (150, 100, 50), 'A'), (2100, 400, 1200, 500, (120, 90, 60), 'B'), (2300, 1500, 400, 300, (190, 190, 190), '101')], exif_rotate=True)
photo('build.jpg', (3000, 2000), [(400, 300, 900, 1400, (160, 110, 60), 'A'), (1500, 700, 1100, 400, (120, 90, 60), 'B')])
photo('check.jpg', (3000, 2000), [(400, 300, 900, 1400, (160, 110, 60), 'A'), (1300, 700, 1100, 400, (120, 90, 60), 'B')])
photo('backseat.jpg', (3000, 2000), [(300, 500, 2400, 900, (40, 40, 45), 'SEAT'), (1100, 1350, 200, 120, (200, 200, 200), 'LA')], bg=(25, 25, 28))
with open(os.path.join(OUT, 'photo.heic'), 'wb') as f:
    f.write(b'\x00\x00\x00\x18ftypheic' + os.urandom(2048))
print('fixtures in', OUT, sorted(os.listdir(OUT)))
