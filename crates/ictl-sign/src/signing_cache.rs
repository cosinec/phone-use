//! Sharing is opt-in for native CLI, explicitly scoped by the gateway runtime.
use crate::{Result, SignError};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub(super) struct Cache {
    pub root: PathBuf,
    pub candidates: Vec<PathBuf>,
}
impl Cache {
    pub fn from_env(account: &Path, account_id: &str, team: &str) -> Result<Self> {
        let root = std::env::var_os("ICTL_SIGNING_ROOT").map(PathBuf::from);
        let legacy = std::env::var_os("ICTL_SIGNING_LEGACY_DATA_ROOT").map(PathBuf::from);
        Self::resolve(account, account_id, team, root.as_deref(), legacy.as_deref())
    }
    fn resolve(
        account: &Path,
        account_id: &str,
        team: &str,
        shared: Option<&Path>,
        legacy: Option<&Path>,
    ) -> Result<Self> {
        if team.is_empty() || !team.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(SignError::Developer("Invalid development team ID".into()));
        }
        let Some(shared) = shared else {
            return Ok(Self { root: account.to_owned(), candidates: vec![] });
        };
        // Account scope prevents people in the same team but distinct gateway
        // accounts from silently sharing private material. Do not use email/ADSID
        // directly as path components, or include either in diagnostics.
        crate::restrict_dir(shared)?;
        reject_symlinks(shared)?;
        let root = shared.join(hex::encode(Sha256::digest(account_id.as_bytes())));
        crate::restrict_dir(&root)?;
        let mut candidates = vec![account.join("keys").join(team).join("key.pem")];
        if let Some(legacy) = legacy {
            reject_symlinks(legacy)?;
            match fs::read_dir(legacy) {
                Ok(entries) => {
                    for entry in entries {
                        let entry = entry?;
                        if !entry.file_type()?.is_dir() {
                            continue;
                        }
                        let old = entry.path().join("account");
                        // Read only stores within this explicit boundary and require
                        // selected Apple account identity to match, not merely team.
                        if same_account(&old.join("accounts.json"), account_id).unwrap_or(false) {
                            candidates.push(old.join("keys").join(team).join("key.pem"));
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
            }
        }
        candidates.sort();
        candidates.dedup();
        Ok(Self { root, candidates })
    }
}
fn reject_symlinks(path: &Path) -> std::io::Result<()> {
    for part in path.ancestors() {
        if part.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(part) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(std::io::Error::other("Symlinked signing storage"));
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
fn same_account(path: &Path, account_id: &str) -> std::io::Result<bool> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    reject_symlinks(path)?;
    let mut file = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)?;
    if !file.metadata()?.is_file() {
        return Ok(false);
    }
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| std::io::Error::other("Invalid legacy account store"))?;
    let Some(selected) = value["selected_account"].as_str() else {
        return Ok(false);
    };
    Ok(value["accounts"][selected]["adsid"].as_str() == Some(account_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_migration_requires_same_account_and_explicit_boundary() {
        let root = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("sign-cache-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        for (session, id) in [("a", "ACCOUNT-A"), ("b", "ACCOUNT-B")] {
            let account = data.join(session).join("account");
            fs::create_dir_all(&account).unwrap();
            fs::write(
                account.join("accounts.json"),
                serde_json::to_vec(&serde_json::json!({
                    "selected_account":"synthetic@example.test", "accounts":{"synthetic@example.test":{"adsid":id}}
                }))
                .unwrap(),
            )
            .unwrap();
        }
        let own = data.join("a/account");
        let shared = root.join("shared");
        let cache = Cache::resolve(&own, "ACCOUNT-A", "TEAM1", Some(&shared), Some(&data)).unwrap();
        assert_eq!(cache.candidates, vec![own.join("keys/TEAM1/key.pem")]);
        let other = Cache::resolve(&own, "ACCOUNT-B", "TEAM1", Some(&shared), None).unwrap();
        assert_ne!(cache.root, other.root);
        assert_eq!(Cache::resolve(&own, "ACCOUNT-A", "TEAM1", None, Some(&data)).unwrap().root, own);
        assert!(Cache::resolve(&own, "ACCOUNT-A", "../TEAM", Some(&shared), None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn symlinked_legacy_store_is_not_imported() {
        let root = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("sign-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("account")).unwrap();
        fs::write(root.join("store"), b"{}").unwrap();
        std::os::unix::fs::symlink(root.join("store"), root.join("account/accounts.json")).unwrap();
        assert!(same_account(&root.join("account/accounts.json"), "A").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
