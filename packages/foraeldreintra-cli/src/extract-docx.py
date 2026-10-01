"""Bounded DOCX text and media extraction. Never execute macros or external links."""
import hashlib, io, json, os, pathlib, stat, sys, zipfile
import xml.etree.ElementTree as ET

def extract():
    data = sys.stdin.buffer.read(25 * 1024 * 1024 + 1)
    if len(data) > 25 * 1024 * 1024:
        raise ValueError('too large')
    target = pathlib.Path(sys.argv[1])
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        entries = z.infolist()
        names = [e.filename for e in entries]
        if len(entries) > 10000 or len(names) != len(set(names)) or sum(e.file_size for e in entries) > 100 * 1024 * 1024:
            raise ValueError('oversized archive')
        if 'word/document.xml' not in names or '[Content_Types].xml' not in names:
            raise ValueError('not docx')
        for e in entries:
            if e.filename.startswith('/') or '\\' in e.filename or '..' in e.filename.split('/') or e.flag_bits & 1 or stat.S_ISLNK(e.external_attr >> 16):
                raise ValueError('unsafe archive')
        text = []
        for name in names:
            if not (name == 'word/document.xml' or name.startswith(('word/header', 'word/footer', 'word/footnotes', 'word/endnotes')) and name.endswith('.xml')):
                continue
            if z.getinfo(name).file_size > 8 * 1024 * 1024:
                raise ValueError('oversized xml')
            raw = z.read(name)
            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper() or b'\0' in raw:
                raise ValueError('unsafe xml')
            root = ET.fromstring(raw)
            ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
            for p in root.iter(ns+'p'):
                parts=[]
                for el in p.iter():
                    if el.tag == ns+'t': parts.append(el.text or '')
                    elif el.tag == ns+'tab': parts.append('\t')
                    elif el.tag in (ns+'br',ns+'cr'): parts.append('\n')
                text.append(''.join(parts))
        images=[]
        for e in entries:
            if not e.filename.startswith('word/media/') or e.is_dir(): continue
            raw=z.read(e)
            digest=hashlib.sha256(raw).hexdigest()
            ext=pathlib.Path(e.filename).suffix.lower()
            if ext not in ('.png','.jpg','.jpeg','.gif','.webp','.tiff','.bmp','.emf','.wmf','.svg'): ext='.bin'
            path=target/(digest+ext)
            try:
                fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(fd,'wb') as out: out.write(raw)
            except FileExistsError:
                if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest: raise ValueError('unsafe output')
            image={'sourcePart':e.filename,'path':str(path),'bytes':len(raw),'sha256':digest}
            try:
                from PIL import Image
                im=Image.open(io.BytesIO(raw)); im.verify()
            except ImportError:
                image['error']='DEPENDENCY_REQUIRED: Pillow is needed to validate embedded images'
            except Exception:
                image['error']='UNREADABLE_EMBEDDED_IMAGE'
            images.append(image)
        return {'text':'\n'.join(text),'images':images,'extractionComplete':not any('error' in i for i in images),'visualReviewRequired':True,'warnings':['Original DOCX retained. Text and embedded images do not preserve page layout; inspect images and open/render the original for complete visual reading.']}
try:
    print(json.dumps(extract(),ensure_ascii=False))
except Exception:
    print('DOCX extraction failed: corrupt, unsafe, or unsupported document.',file=sys.stderr)
    sys.exit(1)
