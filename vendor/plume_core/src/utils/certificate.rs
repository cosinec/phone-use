use std::{fs, path::PathBuf, vec};

use apple_codesign::{
    SigningSettings,
    cryptography::{InMemoryPrivateKey, PrivateKey},
};
// TODO: why do we have pem and pem_rfc7468 deps again?
use pem_rfc7468::{LineEnding, encode_string};
use rand::rngs::OsRng;
use rcgen::{DnType, KeyPair, PKCS_RSA_SHA256};
use rsa::{
    RsaPrivateKey,
    pkcs1::EncodeRsaPublicKey,
    pkcs8::{DecodePrivateKey, EncodePrivateKey},
};
use x509_certificate::{CapturedX509Certificate, X509Certificate};

use crate::{
    Error,
    developer::{DeveloperSession, qh::certs::Cert},
};

pub(crate) const MACHINE_NAME: &str = "AltStore";

pub struct CertificateIdentity {
    pub cert: Option<CapturedX509Certificate>,
    pub key: Option<Box<dyn PrivateKey>>,
    pub machine_id: Option<String>,
    pub serial_number: Option<String>,
    pub p12_data: Option<Vec<u8>>,
    pub new: bool,
}

impl CertificateIdentity {
    // Use for cli context or if you actually store pems? why would you do that though
    pub async fn new_with_paths(paths: Option<Vec<PathBuf>>) -> Result<Self, Error> {
        let mut cert =
            Self { cert: None, key: None, machine_id: None, p12_data: None, serial_number: None, new: false };

        if let Some(paths) = paths {
            for path in &paths {
                let pem_data = fs::read(path)?;
                cert.resolve_certificate_from_contents(pem_data)?;
            }
        }

        Ok(cert)
    }

    pub async fn new_with_session(
        session: &DeveloperSession,
        config_path: PathBuf,
        machine_name: Option<String>,
        team_id: &String,
        is_export: bool,
        on_certificate_reset: Option<&mut dyn FnMut() -> bool>,
    ) -> Result<Self, Error> {
        Self::new_with_session_candidates(
            session,
            config_path,
            machine_name,
            team_id,
            is_export,
            on_certificate_reset,
            &[],
        )
        .await
    }

    /// Local patch: a shared, team-scoped cache. Candidates are supplied only by
    /// the caller's explicitly authorized account/storage boundary.
    pub async fn new_with_session_candidates(
        session: &DeveloperSession,
        config_path: PathBuf,
        machine_name: Option<String>,
        team_id: &String,
        is_export: bool,
        _on_certificate_reset: Option<&mut dyn FnMut() -> bool>,
        candidates: &[PathBuf],
    ) -> Result<Self, Error> {
        Self::with_provider(session, config_path, machine_name, team_id, is_export, candidates).await
    }

    async fn with_provider(
        session: &impl CertificateProvider,
        config_path: PathBuf,
        machine_name: Option<String>,
        team_id: &String,
        is_export: bool,
        candidates: &[PathBuf],
    ) -> Result<Self, Error> {
        let machine_name = machine_name.unwrap_or_else(|| MACHINE_NAME.to_string());
        let dir = Self::key_dir(config_path, team_id)?;
        let _lock = TeamLock::acquire(&dir).await?;
        let key_path = dir.join("key.pem");
        let mut identity =
            Self { cert: None, key: None, machine_id: None, p12_data: None, serial_number: None, new: false };
        // Fail closed if Apple's list cannot be fetched; local certificates alone
        // cannot establish that a certificate has not been revoked.
        let certs = session.list(team_id).await?;
        let mut pending = None;
        for path in std::iter::once(&key_path).chain(candidates.iter()) {
            let key = match read_key(path) {
                Ok(Some(key)) => key,
                Ok(None) => continue,
                Err(e) if path != &key_path => {
                    // Never log PEM contents or paths containing account identifiers.
                    log::warn!("Skipping unusable legacy signing key: {}", e);
                    continue;
                }
                Err(e) => return Err(e),
            };
            if let Some(cert) = identity.find_certificate(certs.clone(), &key).await? {
                write_key(&dir, &key)?;
                return identity.complete(cert, key, is_export);
            }
            if path == &key_path {
                pending = Some(key);
            }
        }
        // Persist before submitting the CSR: cancellation or a failed follow-up
        // list request must not orphan Apple's newly issued certificate.
        let key = match pending {
            Some(key) => key,
            None => RsaPrivateKey::new(&mut OsRng, 2048)?,
        };
        write_key(&dir, &key)?;
        let cert = identity.request_new_certificate(session, team_id, &machine_name, &key).await?;
        identity.new = true;
        identity.complete(cert, key, is_export)
    }

    fn complete(mut self, cert: Cert, key: RsaPrivateKey, is_export: bool) -> Result<Self, Error> {
        let cert_pem = encode_string(
            "CERTIFICATE",
            LineEnding::LF,
            cert.cert_content.ok_or(Error::CertificatePemMissing)?.as_ref(),
        )
        .map_err(|_| Error::Certificate("Invalid certificate encoding".into()))?;
        let pair = [cert_pem.into_bytes(), key.to_pkcs8_pem(Default::default())?.as_bytes().to_vec()];
        self.p12_data = self.create_pkcs12(&pair, is_export);
        for pem in pair {
            self.resolve_certificate_from_contents(pem)?;
        }
        Ok(self)
    }

    fn key_dir(path: PathBuf, team_id: &str) -> Result<PathBuf, Error> {
        if team_id.is_empty() || !team_id.bytes().all(|c| c.is_ascii_alphanumeric()) {
            return Err(Error::Certificate("Invalid development team ID".into()));
        }
        private_dir(&path)?;
        let keys = path.join("keys");
        private_dir(&keys)?;
        let dir = keys.join(team_id);
        private_dir(&dir)?;
        Ok(dir)
    }

    fn set_machine_id(&mut self, machine_id: String) {
        self.machine_id = Some(machine_id);
    }

    fn set_serial_number(&mut self, serial_number: String) {
        self.serial_number = Some(serial_number);
    }

    // TODO: cleanest p12 code of them all
    // the main horror about p12 creation is that we rely on p12-keystore which is
    // just another unnecessary dependency, but the p12 crate that applecodesign-rs
    // uses has no support for modern encryption, hopefully this doesn't add that
    // much more bloat
    pub fn create_pkcs12(&self, data: &[Vec<u8>; 2], is_export: bool) -> Option<Vec<u8>> {
        let cert_der = pem::parse(&data[0]).ok()?.contents().to_vec();
        let key_der = pem::parse(&data[1]).ok()?.contents().to_vec();

        let cert = p12_keystore::Certificate::from_der(&cert_der).ok()?;

        let local_key_id = {
            use sha1::{Digest, Sha1};
            let mut hasher = Sha1::new();
            hasher.update(&key_der);
            let hash = hasher.finalize();
            hash[..8].to_vec()
        };

        let key_chain = p12_keystore::PrivateKeyChain::new(key_der, local_key_id, vec![cert]);

        let mut keystore = p12_keystore::KeyStore::new();
        keystore.add_entry("plume", p12_keystore::KeyStoreEntry::PrivateKeyChain(key_chain));

        // when exporting the user has no idea what the password is, just dont set one
        // otherwise, when not exporting (used for SideStore/AltStore) we use the
        // machine_id since it needs it to locate a matching certificate
        let password = if is_export { "".to_string() } else { self.machine_id.as_deref().unwrap_or("").to_string() };

        let writer = keystore.writer(&password);
        writer.write().ok()
    }

    // applecodesign-rs needs our contents as strings to sign
    fn resolve_certificate_from_contents(&mut self, contents: Vec<u8>) -> Result<(), Error> {
        for pem in pem::parse_many(contents).map_err(Error::Pem)? {
            match pem.tag() {
                "CERTIFICATE" => {
                    self.cert = Some(CapturedX509Certificate::from_der(pem.contents())?);
                }
                "PRIVATE KEY" => {
                    self.key = Some(Box::new(InMemoryPrivateKey::from_pkcs8_der(pem.contents())?));
                }
                "RSA PRIVATE KEY" => {
                    self.key = Some(Box::new(InMemoryPrivateKey::from_pkcs1_der(pem.contents())?));
                }
                tag => log::debug!("(unhandled PEM tag {}; ignoring)", tag),
            }
        }

        Ok(())
    }
}

impl CertificateIdentity {
    async fn find_certificate(&mut self, certs: Vec<Cert>, priv_key: &RsaPrivateKey) -> Result<Option<Cert>, Error> {
        let pub_key_der_obj = priv_key.to_public_key().to_pkcs1_der()?.as_bytes().to_vec();

        for cert in certs {
            if cert.status.eq_ignore_ascii_case("Issued")
                && cert
                    .expiration_date
                    .map(|date| std::time::SystemTime::from(date) > std::time::SystemTime::now())
                    .unwrap_or(true)
            {
                if let Some(cert_content) = &cert.cert_content {
                    let parsed_cert = X509Certificate::from_der(&cert_content)?;
                    if parsed_cert.time_constraints_valid(None)
                        && pub_key_der_obj == parsed_cert.public_key_data().as_ref()
                    {
                        // We need to save the machine_id for our P12
                        if let Some(ref machine_id) = cert.machine_id {
                            self.set_machine_id(machine_id.clone());
                        }

                        self.set_serial_number(cert.serial_number.clone());

                        return Ok(Some(cert));
                    }
                }
            }
        }

        Ok(None)
    }

    async fn request_new_certificate(
        &mut self,
        session: &impl CertificateProvider,
        team_id: &String,
        machine_name: &String,
        priv_key: &RsaPrivateKey,
    ) -> Result<Cert, Error> {
        let priv_key_der = priv_key.to_pkcs8_der()?;
        let priv_key_pair = KeyPair::from_der(priv_key_der.as_bytes())?;

        let mut params = rcgen::CertificateParams::new(vec![]);
        params.alg = &PKCS_RSA_SHA256;
        params.key_pair = Some(priv_key_pair);

        let dn = &mut params.distinguished_name;
        dn.push(DnType::CountryName, "US");
        dn.push(DnType::StateOrProvinceName, "STATE");
        dn.push(DnType::LocalityName, "LOCAL");
        dn.push(DnType::OrganizationName, "ORGNIZATION");
        dn.push(DnType::CommonName, "CN");

        let cert_csr = rcgen::Certificate::from_params(params)?.serialize_request_pem()?;

        // Never revoke another device's signing identity to make quota room.
        let cert_id = session.submit(team_id, cert_csr, machine_name).await.map_err(certificate_request_error)?;

        // We need to save the machine_id for our P12
        if let Some(ref machine_id) = cert_id.machine_id {
            self.set_machine_id(machine_id.clone());
        }

        self.set_serial_number(cert_id.serial_number.clone());

        // We request again, and hope this has our new certificate
        // ready.... if not then woops... thats too bad isnt it
        let certs = session.list(team_id).await?.into_iter().find(|c| c.certificate_id == cert_id.certificate_id);

        let cert = certs.ok_or(Error::CertificatePemMissing)?;
        self.find_certificate(vec![cert], priv_key)
            .await?
            .ok_or_else(|| Error::Certificate("Apple returned an unusable development certificate".into()))
    }
}

impl CertificateIdentity {
    pub fn load_into_signing_settings<'settings, 'slf: 'settings>(
        &'slf self,
        settings: &'settings mut SigningSettings<'slf>,
    ) -> Result<(), Error> {
        let signing_cert = self.cert.clone().ok_or(Error::CertificatePemMissing)?;
        let signing_key = self.key.as_ref().ok_or(Error::CertificatePemMissing)?;

        settings.set_signing_key(signing_key.as_key_info_signer(), signing_cert);
        settings.chain_apple_certificates();
        settings.set_team_id_from_signing_certificate();

        Ok(())
    }
}

// Local patch: Unix advisory locks are shared by sessions and processes, released
// by close even after cancellation/crash. Nonblocking polling keeps Tokio responsive.
struct TeamLock(fs::File);
impl TeamLock {
    async fn acquire(dir: &std::path::Path) -> Result<Self, Error> {
        use std::os::fd::AsRawFd;
        let file = secure_open(&dir.join(".lock"), true)?;
        loop {
            // SAFETY: valid owned file descriptor; LOCK_NB never blocks the executor.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(Self(file));
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::WouldBlock {
                return Err(error.into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }
}
impl Drop for TeamLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: descriptor remains valid until the file is dropped.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
fn private_dir(path: &std::path::Path) -> Result<(), Error> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    }
    if !fs::symlink_metadata(path)?.file_type().is_dir() {
        return Err(Error::Certificate("Signing cache must be a directory, not a symlink".into()));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn secure_open(path: &std::path::Path, create: bool) -> Result<fs::File, Error> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = fs::OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(Error::Certificate("Signing key must be a regular file".into()));
    }
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}
fn read_key(path: &std::path::Path) -> Result<Option<RsaPrivateKey>, Error> {
    use std::io::Read;
    // Reject symlinked ancestors too, including legacy session/account/keys.
    for parent in path.ancestors().skip(1) {
        if parent.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(parent) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(Error::Certificate("Symlinked signing key directory".into()));
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        }
    }
    let mut file = match secure_open(path, false) {
        Ok(file) => file,
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut pem = String::new();
    file.read_to_string(&mut pem)?;
    RsaPrivateKey::from_pkcs8_pem(&pem).map(Some).map_err(|_| Error::Certificate("Invalid cached signing key".into()))
}
fn write_key(dir: &std::path::Path, key: &RsaPrivateKey) -> Result<(), Error> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let temporary = dir.join(format!(".key-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary)?;
        file.write_all(key.to_pkcs8_pem(Default::default())?.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, dir.join("key.pem"))?;
        fs::File::open(dir)?.sync_all()?;
        Ok::<_, Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn certificate_request_error(error: Error) -> Error {
    if matches!(&error, Error::DeveloperApi { result_code: 7460, .. }) {
        Error::Certificate("Development certificate quota reached. No certificates were revoked. Import/reuse a valid team signing key or explicitly manage certificates in Apple Developer; replacing a certificate can disable other devices.".into())
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Provider {
        certificates: Vec<Cert>,
        submits: AtomicUsize,
    }
    impl CertificateProvider for Provider {
        async fn list(&self, _: &String) -> Result<Vec<Cert>, Error> {
            Ok(self.certificates.clone())
        }
        async fn submit(&self, _: &String, _: String, _: &String) -> Result<IssuedCertificate, Error> {
            self.submits.fetch_add(1, Ordering::SeqCst);
            Err(Error::DeveloperApi {
                url: "fixture".into(),
                result_code: 7460,
                http_code: None,
                message: "quota".into(),
            })
        }
    }
    fn fixture(key: &RsaPrivateKey, status: &str) -> Cert {
        let mut params = rcgen::CertificateParams::new(vec![]);
        params.alg = &PKCS_RSA_SHA256;
        params.key_pair = Some(KeyPair::from_der(key.to_pkcs8_der().unwrap().as_bytes()).unwrap());
        let der = rcgen::Certificate::from_params(params).unwrap().serialize_der().unwrap();
        plist::from_value(&plist::Value::Dictionary(
            [
                ("name".to_string(), plist::Value::String("fixture".into())),
                ("certificateId".to_string(), plist::Value::String("fixture".into())),
                ("serialNumber".to_string(), plist::Value::String("123".into())),
                ("status".to_string(), plist::Value::String(status.into())),
                ("certContent".to_string(), plist::Value::Data(der)),
            ]
            .into_iter()
            .collect(),
        ))
        .unwrap()
    }
    fn temporary() -> PathBuf {
        let path = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("certificate-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        path
    }
    #[tokio::test]
    async fn migrates_valid_legacy_key_and_reuses_without_creating() {
        let root = temporary();
        let legacy = SelfPath::key(&root, "legacy");
        let key = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
        write_key(&legacy, &key).unwrap();
        let provider = Provider { certificates: vec![fixture(&key, "Issued")], submits: AtomicUsize::new(0) };
        let shared = root.join("shared");
        let team = "TEAM1".to_string();
        for candidates in [vec![legacy.join("key.pem")], vec![]] {
            let identity =
                CertificateIdentity::with_provider(&provider, shared.clone(), None, &team, false, &candidates)
                    .await
                    .unwrap();
            assert!(!identity.new);
            assert!(identity.cert.is_some());
        }
        assert_eq!(provider.submits.load(Ordering::SeqCst), 0);
        assert!(legacy.join("key.pem").exists());
        fs::remove_dir_all(root).unwrap();
    }
    struct SelfPath;
    impl SelfPath {
        fn key(root: &std::path::Path, name: &str) -> PathBuf {
            let path = root.join(name);
            fs::create_dir(&path).unwrap();
            path
        }
    }
    #[tokio::test]
    async fn revoked_key_is_not_reused_and_quota_never_revokes() {
        let root = temporary();
        let team = "TEAM1".to_string();
        let dir = CertificateIdentity::key_dir(root.clone(), &team).unwrap();
        let key = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
        write_key(&dir, &key).unwrap();
        let before = fs::read(dir.join("key.pem")).unwrap();
        let provider = Provider { certificates: vec![fixture(&key, "Revoked")], submits: AtomicUsize::new(0) };
        let result = CertificateIdentity::with_provider(&provider, root.clone(), None, &team, false, &[]).await;
        let error = result.err().unwrap().to_string();
        assert!(error.contains("No certificates were revoked"));
        assert_eq!(provider.submits.load(Ordering::SeqCst), 1);
        assert_eq!(before, fs::read(dir.join("key.pem")).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn team_lock_serializes_and_cancellation_releases_waiter() {
        let root = temporary();
        let first = TeamLock::acquire(&root).await.unwrap();
        assert!(tokio::time::timeout(std::time::Duration::from_millis(60), TeamLock::acquire(&root)).await.is_err());
        drop(first);
        let next =
            tokio::time::timeout(std::time::Duration::from_secs(1), TeamLock::acquire(&root)).await.unwrap().unwrap();
        drop(next);
        assert!(read_key(&root.join("missing/key.pem")).unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }
}

// Deliberately has no revoke operation: quota handling cannot destroy identities.
trait CertificateProvider {
    fn list(&self, team: &String) -> impl std::future::Future<Output = Result<Vec<Cert>, Error>> + Send;
    fn submit(
        &self,
        team: &String,
        csr: String,
        name: &String,
    ) -> impl std::future::Future<Output = Result<IssuedCertificate, Error>> + Send;
}
struct IssuedCertificate {
    certificate_id: String,
    serial_number: String,
    machine_id: Option<String>,
}
impl CertificateProvider for DeveloperSession {
    async fn list(&self, team: &String) -> Result<Vec<Cert>, Error> {
        Ok(self.qh_list_certs(team).await?.certificates)
    }
    async fn submit(&self, team: &String, csr: String, name: &String) -> Result<IssuedCertificate, Error> {
        let cert = self.qh_submit_cert_csr(team, csr, name).await?.cert_request;
        Ok(IssuedCertificate {
            certificate_id: cert.certificate_id,
            serial_number: cert.serial_num,
            machine_id: cert.machine_id,
        })
    }
}
