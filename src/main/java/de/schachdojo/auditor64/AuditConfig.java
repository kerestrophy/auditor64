package de.schachdojo.auditor64;

import java.nio.file.Path;
import java.util.OptionalInt;

public record AuditConfig(
        Path projectRoot,
        Path setInputPath,
        Path stockfishPath,
        OptionalInt limit
) {
    public Path scriptPath() {
        return projectRoot.resolve("backend")
                .resolve("scripts")
                .resolve("audit-engine-didactics-downloaded-sets.js");
    }
}
