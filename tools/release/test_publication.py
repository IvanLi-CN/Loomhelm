import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from policy import ReleaseError, reserve
from ledger import transition
from product import publish


class MemoryLedger:
    def __init__(self,record):self.state={'releases':{record['id']:record}};self.fail=False
    def append(self,state):
        if self.fail:raise ReleaseError('lost completion response')


class Provider:
    def __init__(self):self.draft=True;self.assets={};self.uploads=0;self.publications=0;self.fail_upload=False;self.tag_wrong=False
    def verify_tag(self,*args,**kwargs):
        if self.tag_wrong:raise ReleaseError('tag collision')
    def ensure_draft(self,r):
        self.verify_tag()
        return dict(id=1,draft=self.draft)
    def api(self,path,method='GET',body=None):
        if method=='PATCH':self.draft=False;self.publications+=1;return {}
        return [dict(id=name,name=name) for name in self.assets]
    def asset_bytes(self,a):return self.assets[a['name']]
    def upload(self,release,name,path,expected):
        self.uploads+=1
        if name in self.assets and hashlib.sha256(self.assets[name]).hexdigest()!=expected:raise ReleaseError('asset conflict')
        self.assets[name]=path.read_bytes()
        if self.fail_upload:self.fail_upload=False;raise ReleaseError('upload response lost')
    def verify_assets(self,release,inventory):
        for name,digest in inventory.items():
            if name not in self.assets or hashlib.sha256(self.assets[name]).hexdigest()!=digest:raise ReleaseError('incomplete asset')
        return inventory


def frozen():
    r=reserve({},'1.0.0','a'*40,'policy','owner',None)
    transition(r,'prepared',branch='th/release',preparation_sha='b'*40)
    transition(r,'bound',merge_sha='c'*40)
    transition(r,'staged',artifacts={'package':hashlib.sha256(b'original').hexdigest()})
    transition(r,'frozen',artifacts={'package':hashlib.sha256(b'original').hexdigest()})
    return r


class PublicationTests(unittest.TestCase):
    def test_lost_upload_response_recovers_same_identity(self):
        r=frozen();api=Provider();api.fail_upload=True;ledger=MemoryLedger(r);identity=copy.deepcopy(r)
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp);(directory/'package').write_bytes(b'original')
            with self.assertRaises(ReleaseError):publish(api,ledger,r,directory)
            self.assertTrue(api.draft)
            # Original is now durable; recovery works even after local bytes vanish.
            (directory/'package').unlink()
            publish(api,ledger,r,directory)
        self.assertEqual(r['id'],identity['id']);self.assertEqual(r['version'],identity['version']);self.assertEqual(r['artifacts'],identity['artifacts']);self.assertEqual(r['state'],'completed');self.assertEqual(api.uploads,1)

    def test_public_but_completion_response_lost(self):
        r=frozen();api=Provider();api.draft=False;api.assets={'package':b'original'};ledger=MemoryLedger(r);ledger.fail=True
        with self.assertRaises(ReleaseError):publish(api,ledger,r,Path('/missing'))
        # Real failed CAS keeps the old authoritative state; reread it on retry.
        r=frozen();ledger=MemoryLedger(r)
        publish(api,ledger,r,Path('/missing'))
        self.assertEqual(r['state'],'completed');self.assertEqual(api.publications,0)

    def test_missing_or_conflicting_original_is_never_rebuilt(self):
        for assets in ({},{'package':b'wrong'}):
            r=frozen();api=Provider();api.assets=assets
            with self.assertRaises(ReleaseError):publish(api,MemoryLedger(r),r,Path('/missing'))
            self.assertTrue(api.draft);self.assertEqual(api.uploads,0)

    def test_tag_collision_stops_before_upload(self):
        r=frozen();api=Provider();api.tag_wrong=True
        with self.assertRaises(ReleaseError):publish(api,MemoryLedger(r),r,Path('/missing'))
        self.assertEqual(api.uploads,0)

    def test_partial_upload_is_staged_until_all_originals_are_durable(self):
        from unittest.mock import patch
        record=frozen();record['state']='bound';record['artifacts']={}
        api=Provider();api.fail_upload=True;ledger=MemoryLedger(record)
        with tempfile.TemporaryDirectory() as tmp, patch('product.inventory',return_value={'package':hashlib.sha256(b'original').hexdigest()}):
            directory=Path(tmp);(directory/'package').write_bytes(b'original')
            with self.assertRaises(ReleaseError):publish(api,ledger,record,directory)
            self.assertEqual(record['state'],'staged')
            (directory/'package').unlink()
            publish(api,ledger,record,directory)
        self.assertEqual(record['state'],'completed')
        self.assertEqual(api.uploads,1)
