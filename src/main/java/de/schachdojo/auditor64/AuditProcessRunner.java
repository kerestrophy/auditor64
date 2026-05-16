package de.schachdojo.auditor64;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.OptionalInt;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

public final class AuditProcessRunner {
    private volatile Process process;
    private volatile boolean cancelled;

    public void validate(AuditConfig config) throws AuditValidationException {
        if (!Files.isDirectory(config.projectRoot())) {
            throw new AuditValidationException("Der e-schachdojo-Projektordner existiert nicht: " + config.projectRoot());
        }
        if (!Files.isRegularFile(config.scriptPath())) {
            throw new AuditValidationException("Das Audit-Script wurde nicht gefunden: " + config.scriptPath());
        }
        if (!Files.isDirectory(config.setInputPath()) && !Files.isRegularFile(config.setInputPath())) {
            throw new AuditValidationException("Der JSON-Set-Ordner oder die JSON-Datei existiert nicht: " + config.setInputPath());
        }
        if (!Files.isRegularFile(config.stockfishPath())) {
            throw new AuditValidationException("Der Stockfish-Pfad existiert nicht: " + config.stockfishPath());
        }
        if (!isNodeAvailable()) {
            throw new AuditValidationException("Node ist nicht verfügbar. Test fehlgeschlagen: node --version");
        }
    }

    public AuditResult run(AuditConfig config, Consumer<String> outputConsumer)
            throws IOException, InterruptedException {
        cancelled = false;

        Path inputDirectory = resolveInputDirectory(config);
        List<String> command = buildCommand(config, inputDirectory);
        outputConsumer.accept("> " + String.join(" ", quoteForDisplay(command)) + System.lineSeparator());

        ProcessBuilder processBuilder = new ProcessBuilder(command);
        processBuilder.directory(config.projectRoot().toFile());

        process = processBuilder.start();
        CountDownLatch readersDone = new CountDownLatch(2);
        Thread stdoutThread = stream(process.getInputStream(), outputConsumer, readersDone);
        Thread stderrThread = stream(process.getErrorStream(), outputConsumer, readersDone);

        int exitCode = process.waitFor();
        readersDone.await(5, TimeUnit.SECONDS);

        stdoutThread.interrupt();
        stderrThread.interrupt();
        process = null;

        if (cancelled) {
            return AuditResult.cancelledResult();
        }
        return AuditResult.finished(exitCode);
    }

    public void cancel() {
        cancelled = true;
        Process current = process;
        if (current == null) {
            return;
        }

        current.destroy();
        try {
            if (!current.waitFor(Duration.ofSeconds(2).toMillis(), TimeUnit.MILLISECONDS)) {
                current.destroyForcibly();
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            current.destroyForcibly();
        }
    }

    private boolean isNodeAvailable() {
        try {
            Process process = new ProcessBuilder("node", "--version").start();
            boolean exited = process.waitFor(5, TimeUnit.SECONDS);
            return exited && process.exitValue() == 0;
        } catch (IOException exception) {
            return false;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private Path resolveInputDirectory(AuditConfig config) throws IOException {
        if (Files.isDirectory(config.setInputPath())) {
            return config.setInputPath();
        }

        if (!config.setInputPath().getFileName().toString().toLowerCase().endsWith(".json")) {
            throw new IOException("Einzeldatei muss eine .json-Datei sein: " + config.setInputPath());
        }

        Path singleFileDirectory = Path.of("").toAbsolutePath()
                .resolve("target")
                .resolve("auditor64-single-file-input")
                .normalize();
        recreateDirectory(singleFileDirectory);
        Files.copy(
                config.setInputPath(),
                singleFileDirectory.resolve(config.setInputPath().getFileName()),
                StandardCopyOption.REPLACE_EXISTING
        );
        return singleFileDirectory;
    }

    private void recreateDirectory(Path directory) throws IOException {
        if (Files.exists(directory)) {
            try (var paths = Files.walk(directory)) {
                paths.sorted(Comparator.reverseOrder())
                        .filter(path -> !path.equals(directory))
                        .forEach(path -> {
                            try {
                                Files.deleteIfExists(path);
                            } catch (IOException exception) {
                                throw new IllegalStateException("Konnte Datei nicht löschen: " + path, exception);
                            }
                        });
            } catch (IllegalStateException exception) {
                if (exception.getCause() instanceof IOException ioException) {
                    throw ioException;
                }
                throw exception;
            }
        }
        Files.createDirectories(directory);
    }

    private List<String> buildCommand(AuditConfig config, Path inputDirectory) {
        List<String> command = new ArrayList<>();
        command.add("node");
        command.add(config.scriptPath().toString());
        command.add("--dir");
        command.add(inputDirectory.toString());
        command.add("--stockfish");
        command.add(config.stockfishPath().toString());
        OptionalInt limit = config.limit();
        if (limit.isPresent()) {
            command.add("--limit");
            command.add(Integer.toString(limit.getAsInt()));
        }
        return command;
    }

    private Thread stream(InputStream inputStream, Consumer<String> outputConsumer, CountDownLatch done) {
        Thread thread = new Thread(() -> {
            Charset charset = Charset.defaultCharset();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, charset))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    outputConsumer.accept(line + System.lineSeparator());
                }
            } catch (IOException exception) {
                outputConsumer.accept("Stream-Fehler: " + exception.getMessage() + System.lineSeparator());
            } finally {
                done.countDown();
            }
        }, "audit-output-reader");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    private List<String> quoteForDisplay(List<String> command) {
        return command.stream()
                .map(value -> value.contains(" ") ? "\"" + value + "\"" : value)
                .toList();
    }

    public record AuditResult(boolean cancelled, int exitCode) {
        public static AuditResult cancelledResult() {
            return new AuditResult(true, -1);
        }

        public static AuditResult finished(int exitCode) {
            return new AuditResult(false, exitCode);
        }
    }

    public static final class AuditValidationException extends Exception {
        public AuditValidationException(String message) {
            super(message);
        }
    }
}
