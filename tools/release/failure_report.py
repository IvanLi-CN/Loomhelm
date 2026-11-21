"""Canonical caller-provided Oidrune summary. Oidrune adds no metadata."""


def common(run):
    actor = run.get('actor') or {}
    return [
        'Loomhelm release failure',
        'Workflow: ' + run['name'],
        'Conclusion: ' + run['conclusion'],
        'Event: ' + run['event'],
        'Ref: ' + run['head_branch'],
        'Head SHA: ' + run['head_sha'],
        'Run: ' + run['html_url'],
        'Attempt: ' + str(run['run_attempt']),
        'Actor: ' + (actor.get('login') or 'unknown'),
    ]


def summary(run, tail):
    return '\n'.join(common(run) + list(tail))
