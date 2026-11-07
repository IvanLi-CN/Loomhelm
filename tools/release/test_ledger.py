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

    def test_verified_platform_history_is_read_and_append_only_semantics_are_checked(self):
        from unittest.mock import Mock
        import json
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['git','init','--bare',tmp+'/remote'],check=True,capture_output=True)
            subprocess.run(['git','init',tmp+'/local'],check=True,capture_output=True)
            os.chdir(tmp+'/local')
            try:
                def run(*args):return subprocess.check_output(['git',*args],stderr=subprocess.PIPE).decode().strip()
                run('config','user.email','fixture@example.invalid')
                run('config','user.name','Platform API Fixture')
                run('config','commit.gpgsign','false')
                run('remote','add','origin',tmp+'/remote')
                # Real Git history; API verification is injected here, not claimed
                # as empirical evidence for GitHub's actual signing service.
                run('commit','--allow-empty','--signoff','-m','chore: fixture seed')
                seed = run('rev-parse','HEAD')
                state={'schema_version':1,'releases':{'one':{'id':'one','version':'1.0.0','intent':{},'events':[{'sequence':1,'kind':'reserved'}]}}}
                Path('ledger.json').write_text(json.dumps(state))
                run('add','ledger.json');run('commit','--signoff','-m','chore: fixture record')
                first=run('rev-parse','HEAD')
                run('push','origin','HEAD:refs/heads/release-ledger')
                api=Mock()
                ledger=Ledger(api=api)
                self.assertEqual(ledger.read(),state)
                self.assertEqual(ledger.read(),state)
                api.verify_record_commit.assert_called_with(first)
                api.verify_source.assert_called_with(seed,[])
                state['releases']['one']['events'].append({'sequence':2,'kind':'notification'})
                Path('ledger.json').write_text(json.dumps(state))
                run('add','ledger.json');run('commit','--signoff','-m','chore: fixture append')
                run('push','origin','HEAD:refs/heads/release-ledger')
                self.assertEqual(Ledger(api=api).read(),state)
                state['releases']['one']['events'][0]['kind']='rewritten'
                Path('ledger.json').write_text(json.dumps(state))
                run('add','ledger.json');run('commit','--signoff','-m','chore: fixture corrupt')
                run('push','origin','HEAD:refs/heads/release-ledger')
                with self.assertRaises(ReleaseError):Ledger(api=api).read()
            finally:
                os.chdir(previous)
