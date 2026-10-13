//! Which files the page may read (#123).
//!
//! The page asks for folders and files by path, and a compromised page could
//! ask for any path the user can read. So the shell keeps the folders the
//! user picked in the native picker, and reads only those folders and the
//! regular files directly inside them. Paths are compared after resolving
//! symlinks and `..`, so neither can step outside a picked folder.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct FolderScope {
    allowed: HashSet<PathBuf>,
}

fn resolve(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))
}

fn refused(path: &Path) -> String {
    format!(
        "{} is not in a folder you chose; choose its folder first.",
        path.display()
    )
}

impl FolderScope {
    /// Allow a folder the user picked. Returns its resolved path.
    pub fn allow(&mut self, folder: &Path) -> Result<PathBuf, String> {
        let resolved = resolve(folder)?;
        self.allowed.insert(resolved.clone());
        Ok(resolved)
    }

    /// `folder`, resolved, if the user picked it.
    pub fn folder(&self, folder: &Path) -> Result<PathBuf, String> {
        let resolved = resolve(folder)?;
        if self.allowed.contains(&resolved) {
            Ok(resolved)
        } else {
            Err(refused(folder))
        }
    }

    /// `path`, resolved, if it is a file directly inside a picked folder.
    pub fn file(&self, path: &Path) -> Result<PathBuf, String> {
        let resolved = resolve(path)?;
        let inside = resolved
            .parent()
            .is_some_and(|parent| self.allowed.contains(parent));
        if inside && resolved.is_file() {
            Ok(resolved)
        } else {
            Err(refused(path))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A fresh directory with `docs/bill.png`, `docs/sub/x.png` and `secret.txt`.
    fn tree(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("outtray-scope-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("docs/sub")).unwrap();
        fs::write(root.join("docs/bill.png"), b"png").unwrap();
        fs::write(root.join("docs/sub/x.png"), b"png").unwrap();
        fs::write(root.join("secret.txt"), b"secret").unwrap();
        root
    }

    #[test]
    fn refuses_everything_before_a_folder_is_picked() {
        let root = tree("empty");
        let scope = FolderScope::default();
        assert!(scope.folder(&root.join("docs")).is_err());
        assert!(scope.file(&root.join("docs/bill.png")).is_err());
    }

    #[test]
    fn reads_a_picked_folder_and_the_files_directly_in_it() {
        let root = tree("picked");
        let mut scope = FolderScope::default();
        scope.allow(&root.join("docs")).unwrap();
        assert!(scope.folder(&root.join("docs")).is_ok());
        assert!(scope.file(&root.join("docs/bill.png")).is_ok());
    }

    #[test]
    fn refuses_files_outside_or_below_the_picked_folder() {
        let root = tree("outside");
        let mut scope = FolderScope::default();
        scope.allow(&root.join("docs")).unwrap();
        assert!(scope.file(&root.join("secret.txt")).is_err());
        assert!(scope.file(&root.join("docs/../secret.txt")).is_err());
        assert!(scope.file(&root.join("docs/sub/x.png")).is_err());
        assert!(scope.folder(&root).is_err());
        assert!(scope.folder(&root.join("docs/sub")).is_err());
    }

    #[test]
    fn refuses_the_folder_itself_as_a_file() {
        let root = tree("dir");
        let mut scope = FolderScope::default();
        scope.allow(&root).unwrap();
        assert!(scope.file(&root.join("docs")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_points_outside() {
        let root = tree("link");
        std::os::unix::fs::symlink(root.join("secret.txt"), root.join("docs/link.png")).unwrap();
        let mut scope = FolderScope::default();
        scope.allow(&root.join("docs")).unwrap();
        assert!(scope.file(&root.join("docs/link.png")).is_err());
    }
}
