import copy
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
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
