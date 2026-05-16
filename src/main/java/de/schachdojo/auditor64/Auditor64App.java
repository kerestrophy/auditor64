package de.schachdojo.auditor64;

import de.schachdojo.auditor64.AuditProcessRunner.AuditResult;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.concurrent.Task;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Scene;
import javafx.scene.control.Button;
import javafx.scene.control.Label;
import javafx.scene.control.TextArea;
import javafx.scene.control.TextField;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.ColumnConstraints;
import javafx.scene.layout.GridPane;
import javafx.scene.layout.HBox;
import javafx.scene.layout.Priority;
import javafx.stage.DirectoryChooser;
import javafx.stage.FileChooser;
import javafx.stage.Stage;

import java.io.File;
import java.nio.file.Path;
import java.util.OptionalInt;

public final class Auditor64App extends Application {
    private static final Path DEFAULT_PROJECT_ROOT = Path.of("O:", "e-schachdojo-clean", "e-schachdojo");
    private static final Path DEFAULT_JSON_SELECTION_ROOT = Path.of("O:", "e-schachdojo-clean", "content-audit");
    private static final Path DEFAULT_STOCKFISH_PATH = Path.of(
            "O:", "e-schachdojo-clean", "auditor64", "src", "main", "resources", "engine", "stockfish.exe"
    );

    private final AuditProcessRunner runner = new AuditProcessRunner();

    private TextField projectRootField;
    private TextField setDirectoryField;
    private TextField stockfishField;
    private TextField limitField;
    private TextArea outputArea;
    private Label statusLabel;
    private Button startButton;
    private Button cancelButton;

    @Override
    public void start(Stage stage) {
        projectRootField = new TextField(DEFAULT_PROJECT_ROOT.toString());
        setDirectoryField = new TextField();
        stockfishField = new TextField(DEFAULT_STOCKFISH_PATH.toString());
        limitField = new TextField("25");

        outputArea = new TextArea();
        outputArea.setEditable(false);
        outputArea.setWrapText(false);

        statusLabel = new Label("Bereit");
        startButton = new Button("Audit starten");
        cancelButton = new Button("Abbrechen");
        cancelButton.setDisable(true);

        BorderPane root = new BorderPane();
        root.setPadding(new Insets(12));
        root.setTop(createForm(stage));
        root.setCenter(outputArea);
        root.setBottom(createFooter());

        BorderPane.setMargin(outputArea, new Insets(12, 0, 12, 0));

        startButton.setOnAction(event -> startAudit());
        cancelButton.setOnAction(event -> cancelAudit());

        Scene scene = new Scene(root, 920, 640);
        stage.setTitle("auditor64");
        stage.setMinWidth(760);
        stage.setMinHeight(520);
        stage.setScene(scene);
        stage.show();
    }

    private GridPane createForm(Stage stage) {
        GridPane grid = new GridPane();
        grid.setHgap(8);
        grid.setVgap(8);

        ColumnConstraints labelColumn = new ColumnConstraints();
        labelColumn.setMinWidth(190);
        ColumnConstraints inputColumn = new ColumnConstraints();
        inputColumn.setHgrow(Priority.ALWAYS);
        ColumnConstraints buttonColumn = new ColumnConstraints();
        buttonColumn.setMinWidth(110);
        grid.getColumnConstraints().addAll(labelColumn, inputColumn, buttonColumn);

        addRow(grid, 0, "e-schachdojo-Projektordner", projectRootField, null);
        addRow(grid, 1, "JSON-Set-Ordner/-Datei", setDirectoryField, jsonSelectionButtons(stage, setDirectoryField));
        addRow(grid, 2, "Stockfish-Pfad", stockfishField, fileButton(stage, stockfishField));
        addRow(grid, 3, "Limit optional", limitField, null);

        return grid;
    }

    private HBox createFooter() {
        HBox footer = new HBox(10, statusLabel, startButton, cancelButton);
        footer.setAlignment(Pos.CENTER_RIGHT);
        HBox.setHgrow(statusLabel, Priority.ALWAYS);
        statusLabel.setMaxWidth(Double.MAX_VALUE);
        return footer;
    }

    private void addRow(GridPane grid, int row, String labelText, TextField field, javafx.scene.Node control) {
        Label label = new Label(labelText);
        field.setMaxWidth(Double.MAX_VALUE);
        grid.add(label, 0, row);
        grid.add(field, 1, row);
        if (control != null) {
            grid.add(control, 2, row);
        }
    }

    private HBox jsonSelectionButtons(Stage stage, TextField target) {
        Button directoryButton = new Button("Ordner...");
        directoryButton.setOnAction(event -> {
            DirectoryChooser chooser = new DirectoryChooser();
            chooser.setTitle("JSON-Set-Ordner auswählen");
            setInitialDirectory(chooser, target.getText(), DEFAULT_JSON_SELECTION_ROOT);
            File selected = chooser.showDialog(stage);
            if (selected != null) {
                target.setText(selected.toPath().toString());
            }
        });

        Button fileButton = new Button("Datei...");
        fileButton.setOnAction(event -> {
            FileChooser chooser = new FileChooser();
            chooser.setTitle("JSON-Set-Datei auswählen");
            setInitialDirectory(chooser, target.getText(), DEFAULT_JSON_SELECTION_ROOT);
            chooser.getExtensionFilters().add(new FileChooser.ExtensionFilter("JSON-Dateien", "*.json"));
            File selected = chooser.showOpenDialog(stage);
            if (selected != null) {
                target.setText(selected.toPath().toString());
            }
        });

        HBox buttons = new HBox(6, directoryButton, fileButton);
        buttons.setAlignment(Pos.CENTER_LEFT);
        return buttons;
    }

    private Button directoryButton(Stage stage, TextField target) {
        Button button = new Button("Auswählen...");
        button.setOnAction(event -> {
            DirectoryChooser chooser = new DirectoryChooser();
            chooser.setTitle("Ordner auswählen");
            setInitialDirectory(chooser, target.getText(), null);
            File selected = chooser.showDialog(stage);
            if (selected != null) {
                target.setText(selected.toPath().toString());
            }
        });
        return button;
    }

    private Button fileButton(Stage stage, TextField target) {
        Button button = new Button("Auswählen...");
        button.setOnAction(event -> {
            FileChooser chooser = new FileChooser();
            chooser.setTitle("Stockfish auswählen");
            File current = Path.of(target.getText().trim()).toFile();
            File parent = current.isDirectory() ? current : current.getParentFile();
            if (parent != null && parent.isDirectory()) {
                chooser.setInitialDirectory(parent);
            }
            chooser.getExtensionFilters().add(new FileChooser.ExtensionFilter("Executable", "*.exe"));
            File selected = chooser.showOpenDialog(stage);
            if (selected != null) {
                target.setText(selected.toPath().toString());
            }
        });
        return button;
    }

    private void setInitialDirectory(DirectoryChooser chooser, String rawPath, Path fallback) {
        File directory = initialDirectory(rawPath, fallback);
        if (directory != null) {
            chooser.setInitialDirectory(directory);
        }
    }

    private void setInitialDirectory(FileChooser chooser, String rawPath, Path fallback) {
        File directory = initialDirectory(rawPath, fallback);
        if (directory != null) {
            chooser.setInitialDirectory(directory);
        }
    }

    private File initialDirectory(String rawPath, Path fallback) {
        if (rawPath != null && !rawPath.isBlank()) {
            File current = Path.of(rawPath.trim()).toFile();
            File directory = current.isDirectory() ? current : current.getParentFile();
            if (directory != null && directory.isDirectory()) {
                return directory;
            }
        }
        if (fallback == null) {
            return null;
        }
        File fallbackDirectory = fallback.toFile();
        return fallbackDirectory.isDirectory() ? fallbackDirectory : null;
    }

    private void startAudit() {
        outputArea.clear();

        AuditConfig config;
        try {
            config = readConfig();
        } catch (IllegalArgumentException exception) {
            appendOutput("Fehler: " + exception.getMessage() + System.lineSeparator());
            statusLabel.setText("Bereit");
            return;
        }

        setRunning(true);
        statusLabel.setText("Läuft...");

        Task<AuditResult> task = new Task<>() {
            @Override
            protected AuditResult call() throws Exception {
                runner.validate(config);
                return runner.run(config, Auditor64App.this::appendOutput);
            }
        };

        task.setOnSucceeded(event -> {
            AuditResult result = task.getValue();
            if (result.cancelled()) {
                statusLabel.setText("Abgebrochen");
            } else if (result.exitCode() == 0) {
                statusLabel.setText("Erfolgreich beendet");
            } else {
                statusLabel.setText("Fehler, Exit-Code " + result.exitCode());
            }
            setRunning(false);
        });

        task.setOnFailed(event -> {
            Throwable exception = task.getException();
            appendOutput("Fehler: " + exception.getMessage() + System.lineSeparator());
            statusLabel.setText("Fehler");
            setRunning(false);
        });

        Thread thread = new Thread(task, "audit-process");
        thread.setDaemon(true);
        thread.start();
    }

    private AuditConfig readConfig() {
        Path projectRoot = parseRequiredPath(projectRootField, "e-schachdojo-Projektordner");
        Path setDirectory = parseRequiredPath(setDirectoryField, "JSON-Set-Ordner/-Datei");
        Path stockfishPath = parseRequiredPath(stockfishField, "Stockfish-Pfad");
        OptionalInt limit = parseLimit();
        return new AuditConfig(projectRoot, setDirectory, stockfishPath, limit);
    }

    private Path parseRequiredPath(TextField field, String name) {
        String value = field.getText().trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException(name + " ist leer.");
        }
        return Path.of(value).toAbsolutePath().normalize();
    }

    private OptionalInt parseLimit() {
        String value = limitField.getText().trim();
        if (value.isEmpty()) {
            return OptionalInt.empty();
        }
        try {
            int limit = Integer.parseInt(value);
            if (limit <= 0) {
                throw new IllegalArgumentException("Limit muss größer als 0 sein.");
            }
            return OptionalInt.of(limit);
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException("Limit muss eine ganze Zahl sein.");
        }
    }

    private void cancelAudit() {
        runner.cancel();
        statusLabel.setText("Abgebrochen");
        setRunning(false);
    }

    private void setRunning(boolean running) {
        startButton.setDisable(running);
        cancelButton.setDisable(!running);
    }

    private void appendOutput(String text) {
        Platform.runLater(() -> {
            outputArea.appendText(text);
            outputArea.setScrollTop(Double.MAX_VALUE);
        });
    }

    public static void main(String[] args) {
        launch(args);
    }
}
