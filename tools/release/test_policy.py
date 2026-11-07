import copy
import unittest
from policy import Version, ReleaseError, resolve, reserve
from ledger import transition


class PolicyTests(unittest.TestCase):
    def test_ordering(self):
        versions = ['1.0.0-alpha','1.0.0-alpha.1','1.0.0-alpha.beta','1.0.0-beta','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0']
        self.assertEqual(sorted(versions,key=Version), versions)

    def test_invalid(self):
        for value in ['01.2.3','1.2.3+build','1.2','v1.2.3','1.2.3-01','1.2.3-','1.2.3\n']:
            with self.subTest(value=value), self.assertRaises(ReleaseError):
                Version(value)

    def test_targets(self):
        self.assertEqual(resolve('patch','1.2.3'),'1.2.4')
        self.assertEqual(resolve('minor','1.2.3'),'1.3.0')
        self.assertEqual(resolve('major','1.2.3'),'2.0.0')
        self.assertEqual(resolve('0.1.0-rc.1',None),'0.1.0-rc.1')
        for target,baseline in [('patch',None),('',None),('1.2.3-rc.1','1.2.3'),('1.2.3','1.2.3')]:
            with self.assertRaises(ReleaseError): resolve(target,baseline)

    def test_identity_retry_and_collision(self):
        record=reserve({},'minor','a'*40,'policy','owner','1.0.0')
        records={record['id']:record}
        self.assertEqual(reserve(records,'minor','a'*40,'policy','owner','1.0.0'), record)
        with self.assertRaises(ReleaseError): reserve(records,'minor','b'*40,'policy','owner','1.0.0')
        transition(record,'terminated',reason='operator explicitly stopped')
        with self.assertRaises(ReleaseError): reserve(records,'1.1.0','b'*40,'policy','owner','1.0.0')

    def test_state_machine(self):
        r=reserve({},'1.0.0','a'*40,'policy','owner',None)
        with self.assertRaises(ReleaseError): transition(r,'completed',verified_artifacts={})
        transition(r,'prepared',branch='th/release',preparation_sha='b'*40)
        transition(r,'bound',merge_sha='c'*40)
        transition(r,'frozen',artifacts={'a':'digest'})
        with self.assertRaises(ReleaseError): transition(r,'completed',verified_artifacts={'a':'wrong'})
        transition(r,'completed',verified_artifacts={'a':'digest'})
        self.assertEqual(r['version'],'1.0.0')


if __name__=='__main__': unittest.main()
