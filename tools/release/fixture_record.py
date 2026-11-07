"""Nonpublishing Candidate fixture. No reservation or provider permission."""
import json
import subprocess
from policy import digest
from product import policy_hash, check_projections
print(json.dumps(dict(id='0'*64,version='0.0.0-ci',fixture=True,merge_sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),state='bound',intent=dict(policy_hash=policy_hash()))))
