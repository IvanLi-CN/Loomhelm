import copy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from ledger import Ledger
from policy import ReleaseError


class LedgerTests(unittest.TestCase):
    def test_real_git_compare_and_swap_and_append_history(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['git','init','--bare',tmp+'/remote'],check=True,capture_output=True)
            subprocess.run(['git','init',tmp+'/local'],check=True,capture_output=True)
            os.chdir(tmp+'/local')
            try:
                def run(*args): subprocess.run(['git',*args],check=True,capture_output=True)
                run('config','user.email','fixture@example.invalid')
                run('config','user.name','Release Fixture')
                run('remote','add','origin',tmp+'/remote')
                first,second=Ledger(signed=False),Ledger(signed=False)
                state=first.read()
                second.read()
                state['releases']['one']={'id':'one','version':'1.0.0','intent':{},'events':[{'sequence':1,'kind':'reserved'}]}
                first.append(state)
                with self.assertRaises(ReleaseError): second.append({'schema_version':1,'releases':{'other':{'events':[]}}})
                with self.assertRaises(ReleaseError):Ledger(signed=True).read()
                with self.assertRaises(ReleaseError):first.append({'schema_version':2,'releases':{}})
                old=first.head
                reread=Ledger(signed=False)
                value=reread.read()
                value['releases']['one']['events'].append({'sequence':2,'kind':'bound'})
                reread.append(value)
                run('merge-base','--is-ancestor',old,reread.head)
                self.assertEqual(len(reread.read()['releases']['one']['events']),2)
                reread.state['releases']['one']['events'][0]['kind']='rewritten'
                with self.assertRaises(ReleaseError):reread.append(reread.state)
            finally:
                os.chdir(previous)


    def test_signed_history_is_pinned_to_the_authorized_primary_key(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)/'gpg'
            home.mkdir(mode=0o700)
            with patch.dict(os.environ, {'GNUPGHOME': str(home)}):
                subprocess.run(['gpg','--batch','--passphrase','','--quick-generate-key','Release Fixture <fixture@example.invalid>','ed25519','sign','0'],check=True,capture_output=True)
                keys = subprocess.check_output(['gpg','--batch','--with-colons','--list-secret-keys'],stderr=subprocess.DEVNULL,text=True)
                fingerprint = next(line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:'))
                subprocess.run(['git','init','--bare',tmp+'/remote'],check=True,capture_output=True)
                subprocess.run(['git','init',tmp+'/local'],check=True,capture_output=True)
                os.chdir(tmp+'/local')
                try:
                    def run(*args): subprocess.run(['git',*args],check=True,capture_output=True)
                    run('config','user.name','Release Fixture')
                    run('config','user.email','fixture@example.invalid')
                    run('config','gpg.format','openpgp')
                    run('config','user.signingkey',fingerprint)
                    run('remote','add','origin',tmp+'/remote')
                    ledger = Ledger()
                    with patch.dict(os.environ, {'RELEASE_SIGNING_KEY_ID': fingerprint}):
                        ledger.append(ledger.read())
                        self.assertEqual(Ledger().read()['releases'], {})
                    with patch.dict(os.environ, {'RELEASE_SIGNING_KEY_ID': 'F'*40}), self.assertRaises(ReleaseError):
                        Ledger().read()
                finally:
                    os.chdir(previous)
                    subprocess.run(['gpgconf','--kill','gpg-agent'],capture_output=True)
