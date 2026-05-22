package de.schachdojo.auditor64;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.OptionalInt;

public record AuditConfig(
        Path projectRoot,
        Path setInputPath,
        Path stockfishPath,
        OptionalInt limit
) {
    public Path scriptPath() {
        return auditorRoot().resolve("scripts")
                .resolve("audit-engine-didactics-downloaded-sets.js");
    }

    private Path auditorRoot() {
        try {
            Path codeSource = Path.of(AuditConfig.class.getProtectionDomain()
                            .getCodeSource()
                            .getLocation()
                            .toURI())
                    .toAbsolutePath()
                    .normalize();
            if (Files.isRegularFile(codeSource)) {
                Path jarDirectory = codeSource.getParent();
                if (Files.isDirectory(jarDirectory.resolve("scripts"))) {
                    return jarDirectory;
                }
                if (jarDirectory.getParent() != null && Files.isDirectory(jarDirectory.getParent().resolve("scripts"))) {
                    return jarDirectory.getParent();
                }
                return jarDirectory;
            }
            Path projectRootCandidate = codeSource.getParent() != null && codeSource.getParent().getParent() != null
                    ? codeSource.getParent().getParent()
                    : codeSource;
            if (Files.isDirectory(projectRootCandidate.resolve("scripts"))) {
                return projectRootCandidate;
            }
        } catch (Exception exception) {
            // Fall back to the launch directory below.
        }
        return Path.of("").toAbsolutePath().normalize();
    }
}
