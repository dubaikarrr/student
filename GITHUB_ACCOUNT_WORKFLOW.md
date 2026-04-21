# GitHub Account Workflow

This project can be managed with two different GitHub accounts without constantly breaking your other work.

## What is possible from Codex

Codex can help with:

- local code changes,
- local commits,
- preparing the repository for push,
- setting repository-specific Git config,
- giving you exact push commands,
- verifying the currently connected GitHub app account when the connector changes.

Codex cannot directly:

- switch the GitHub connector account in the app,
- log into your browser,
- complete GitHub OAuth on your behalf,
- create SSH keys inside your GitHub account settings page,
- choose which GitHub account the app connector should use.

## Best low-friction setup

Use two separate layers:

1. `Codex GitHub connector` only when you need GitHub-integrated actions in this app.
2. `Plain Git with SSH` for normal pushing and pulling from each local repo.

That way:

- this student project can push to your student GitHub account,
- your other project can push to `dubaikarrr`,
- you do not need to reconnect the Codex GitHub connector every time you only want to push code.

## Recommended approach: two SSH keys

Create one SSH key per GitHub account and map them with SSH host aliases.

Example SSH config:

```sshconfig
Host github-student
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_student
  IdentitiesOnly yes

Host github-dubaikarrr
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_dubaikarrr
  IdentitiesOnly yes
```

Then use different Git remotes in each repo.

Example for this student project:

```powershell
git remote add origin git@github-student:YOUR_STUDENT_USERNAME/spom-seat-checker.git
```

Example for the other project:

```powershell
git remote add origin git@github-dubaikarrr:dubaikarrr/YOUR_OTHER_REPO.git
```

With this setup, `git push` uses the correct account automatically for each repo.

## Windows SSH setup steps

1. Generate a key for the student account:

```powershell
ssh-keygen -t ed25519 -C "student-account@example.com" -f $HOME\.ssh\id_ed25519_student
```

2. Generate a key for `dubaikarrr` if you do not already have one:

```powershell
ssh-keygen -t ed25519 -C "dubaikarrr@example.com" -f $HOME\.ssh\id_ed25519_dubaikarrr
```

3. Start the SSH agent:

```powershell
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
```

4. Add both keys:

```powershell
ssh-add $HOME\.ssh\id_ed25519_student
ssh-add $HOME\.ssh\id_ed25519_dubaikarrr
```

5. Create or edit `~/.ssh/config` using the alias example above.

6. Copy each public key and add it to the correct GitHub account under:

```text
GitHub -> Settings -> SSH and GPG keys
```

Public key files:

```text
~/.ssh/id_ed25519_student.pub
~/.ssh/id_ed25519_dubaikarrr.pub
```

## Repository-specific commit identity

You can also keep commit author details separate per repo:

```powershell
git config user.name "YOUR STUDENT NAME"
git config user.email "your-student-github-email@example.com"
```

Run those inside this repository only.

For the other repository, set that repo's local `user.name` and `user.email` separately.

## When you need the Codex GitHub connector

Reconnect the app GitHub account only when you need features like:

- PR review help through the GitHub app,
- issue and PR lookup through the connector,
- repo actions that depend on the app-authenticated GitHub context.

You do not need to reconnect just to:

- edit code,
- commit locally,
- push with normal Git and SSH,
- pull updates with normal Git.

## Recommended day-to-day workflow

For this student project:

1. Work locally in Codex.
2. Commit locally.
3. Push with the repo's SSH remote tied to the student account.
4. Only reconnect the Codex GitHub connector if you specifically want GitHub-app features for this repo.

For the other project:

1. Open that project locally.
2. Use its own SSH remote tied to `dubaikarrr`.
3. Reconnect the Codex GitHub connector only if that project needs GitHub-app actions.

## What to send back so Codex can finish setup

For this student project, send:

- your student GitHub username,
- the repo name you want,
- optionally the student GitHub email you want used for commits.

Then Codex can do the remaining local repo setup from this side:

- set repo-specific Git identity,
- add the correct remote command,
- prepare the exact push commands,
- verify local configuration before you push.
