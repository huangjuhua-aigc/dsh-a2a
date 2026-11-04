"""Destructive operations target synthetic fixtures ONLY; invoked by the JS harness."""
import json
import os
import pathlib
import socket
import subprocess
import sys

args = json.loads(sys.argv[1])
checks = []


def check(name, callback):
    try:
        value = callback()
        checks.append({"name": name, "passed": bool(value)})
    except Exception as error:
        checks.append({"name": name, "passed": False, "error": repr(error)})


def denied(name, callback):
    try:
        callback()
        checks.append({"name": name, "passed": False, "error": "operation succeeded"})
    except OSError as error:
        checks.append({"name": name, "passed": True, "errno": error.errno})


public = pathlib.Path('/public')
work = pathlib.Path('/work')
check('public_read', lambda: (public / 'read.txt').read_text() == 'PUBLIC_FIXTURE')
check('own_read', lambda: (work / 'secret.txt').read_text() == args['own'])

denied('public_overwrite', lambda: (public / 'overwrite.txt').write_text('bad'))
denied('public_append', lambda: open(public / 'append.txt', 'a').write('bad'))
denied('public_create', lambda: (public / 'new.txt').write_text('bad'))
denied('public_delete', lambda: (public / 'delete.txt').unlink())
denied('public_rename', lambda: (public / 'rename.txt').rename(public / 'renamed.txt'))
denied('public_move_to_private', lambda: (public / 'move.txt').rename(work / 'stolen.txt'))
denied('public_truncate', lambda: os.truncate(public / 'truncate.txt', 0))
denied('public_mkdir', lambda: (public / 'new-dir').mkdir())
denied('public_rmdir', lambda: (public / 'empty-dir').rmdir())
denied('public_chmod', lambda: (public / 'chmod.txt').chmod(0o777))


def private_crud():
    p = work / 'crud-dir'
    p.mkdir()
    f = p / 'a.txt'
    f.write_text('first')
    with f.open('a') as stream:
        stream.write('-second')
    assert f.read_text() == 'first-second'
    f.write_text('replacement')
    moved = f.rename(p / 'b.txt')
    assert moved.read_text() == 'replacement'
    moved.unlink()
    p.rmdir()
    return not p.exists()


check('own_create_modify_rename_delete', private_crud)

unmounted = ['/work/../' + args['otherPeer'] + '/secret.txt',
             '/private/' + args['otherPeer'] + '/secret.txt',
             '/backend/chat.txt', '/outside/guard.txt',
             '/var/run/docker.sock', '/mnt/c/Users', '/host']
unmounted += args['hostPaths']
for index, target in enumerate(unmounted):
    denied('unmounted_read_' + str(index), lambda target=target: pathlib.Path(target).read_bytes())


def symlink_public():
    p = pathlib.Path('/tmp/public-link')
    p.symlink_to('/public/overwrite.txt')
    try:
        denied('public_write_via_guest_symlink', lambda: p.write_text('bad'))
        return p.read_text() == 'PUBLIC_FIXTURE'
    finally:
        p.unlink()


check('public_symlink_read', symlink_public)
denied('hardlink_public_to_work', lambda: os.link(public / 'overwrite.txt', work / 'alias.txt'))


def root_layer():
    p = pathlib.Path('/tmp/guest-only.txt')
    p.write_text('PRIVATE_VM_LAYER')
    return p.read_text() == 'PRIVATE_VM_LAYER'


check('guest_scratch_writable', root_layer)
check('host_environment_not_inherited', lambda: 'A2A_MSB_HOST_CANARY' not in os.environ)


def network_blocked():
    with socket.socket() as sock:
        sock.settimeout(1)
        try:
            sock.connect(('1.1.1.1', 443))
        except OSError:
            return True
        return False


check('network_blocked', network_blocked)
check('readonly_remount_denied', lambda: subprocess.run(
    ['mount', '-o', 'remount,rw', '/public'], capture_output=True).returncode != 0)
check('public_unchanged_after_remount', lambda: (public / 'overwrite.txt').read_text() == 'PUBLIC_FIXTURE')

payload = ('Generated for ' + args['own'] + '\n生成的文件\n').encode('utf-8') + bytes(range(256))
(work / 'generated.bin').write_bytes(payload)
check('generated_binary_readback', lambda: (work / 'generated.bin').read_bytes() == payload)

print(json.dumps({'uid': os.getuid(), 'checks': checks}, ensure_ascii=False))
