"""Trusted bounded reader. Public data and a visitor's disk are the only roots."""
import json
import os
import pathlib
import stat
import sys

def read_request(args):
    if not isinstance(args, dict) or set(args) - {'root', 'path', 'offset', 'limit'}:
        raise ValueError('Invalid read request')
    root_name = args.get('root', 'public')
    if root_name not in ('public', 'workspace'):
        raise ValueError('Unknown data root')
    root = pathlib.Path('/source' if root_name == 'public' else '/work')
    requested = args.get('path')
    offset, limit = args.get('offset', 1), args.get('limit', 200)
    if not isinstance(requested, str) or not 1 <= len(requested) <= 4096 or any(c in requested for c in ('\0', '\\', ':')):
        raise ValueError('Invalid file path')
    if type(offset) is not int or not 1 <= offset <= 10000000 or type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError('Invalid read pagination')
    target = pathlib.Path(os.path.abspath(root / requested))
    try:
        parts = target.relative_to(root).parts
    except ValueError:
        raise ValueError('Path is outside the authorized data directory')
    current = root
    for component in ('',) + parts:
        current = current / component
        if stat.S_ISLNK(current.lstat().st_mode):
            raise ValueError('Symbolic links are not available')
    before = target.lstat()
    if stat.S_ISDIR(before.st_mode):
        entries, truncated = [], False
        with os.scandir(target) as iterator:
            for index, entry in enumerate(iterator):
                if index >= 1000:
                    truncated = True
                    break
                if entry.is_symlink():
                    continue
                if entry.is_file(follow_symlinks=False) or entry.is_dir(follow_symlinks=False):
                    entries.append(entry.name + ('/' if entry.is_dir(follow_symlinks=False) else ''))
        entries.sort()
        text = '\n'.join(entries[offset - 1:offset - 1 + limit])
        truncated = truncated or len(entries) > offset - 1 + limit
        kind = 'directory'
    else:
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError('Only regular files without hard links can be read')
        if before.st_size > 2 * 1024 * 1024:
            raise ValueError('File exceeds the 2 MiB read limit')
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_nlink) != (before.st_dev, before.st_ino, 1):
                raise ValueError('File changed during open')
            data = stream.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('File exceeds the 2 MiB read limit')
        text = data.decode('utf-8', errors='strict')
        if '\0' in text:
            raise ValueError('Binary files are not supported by read_file')
        lines = text.replace('\r\n', '\n').split('\n')
        text = '\n'.join(lines[offset - 1:offset - 1 + limit])
        truncated = len(lines) > offset - 1 + limit
        kind = 'file'
    after = target.lstat()
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise ValueError('Path changed during read')
    return {'kind': kind, 'path': str(target.relative_to(root)), 'content': text[:32000], 'truncated': truncated or len(text) > 32000}

try:
    if len(sys.argv[1].encode('utf-8')) > 8192:
        raise ValueError('Read request too large')
    print(json.dumps({'result': read_request(json.loads(sys.argv[1]))}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({'error': str(error)}, ensure_ascii=False))
    sys.exit(1)
