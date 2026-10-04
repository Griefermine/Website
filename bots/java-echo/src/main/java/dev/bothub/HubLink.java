package dev.bothub;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.regex.Pattern;

/**
 * Kleine, serverseitige Bot-Hub-Fassade für Java-Bots.
 *
 * Die Runtime-Werte kommen ausschließlich aus der Umgebung des vom Hub
 * gestarteten Prozesses. Tokens werden nur als Authorization-Header gesendet.
 */
public final class HubLink {
    private static final Pattern TOKEN_PATTERN =
            Pattern.compile("[A-Za-z0-9_-]{32,256}");
    private static final Duration TIMEOUT = Duration.ofSeconds(8);

    private final String baseUrl;
    private final String token;
    private final HttpClient client;

    private HubLink(String baseUrl, String token) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.client = HttpClient.newBuilder()
                .connectTimeout(TIMEOUT)
                .build();
    }

    public static HubLink fromEnvironment() {
        String rawUrl = System.getenv().getOrDefault("BOT_HUB_URL", "").trim();
        String rawToken = System.getenv().getOrDefault("BOT_HUB_TOKEN", "").trim();
        if (rawUrl.isEmpty() || rawToken.isEmpty()) {
            return new HubLink("", "");
        }
        URI uri;
        try {
            uri = URI.create(rawUrl);
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("BOT_HUB_URL ist keine gültige URL", error);
        }
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            throw new IllegalStateException("BOT_HUB_URL muss HTTP oder HTTPS verwenden");
        }
        String host = uri.getHost();
        boolean loopback = "127.0.0.1".equalsIgnoreCase(host)
                || "::1".equalsIgnoreCase(host)
                || "localhost".equalsIgnoreCase(host);
        if ("production".equalsIgnoreCase(System.getenv("NODE_ENV"))
                && !"https".equalsIgnoreCase(scheme)
                && !loopback) {
            throw new IllegalStateException("BOT_HUB_URL muss in Produktion HTTPS verwenden");
        }
        if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalStateException("BOT_HUB_URL darf keine Zugangsdaten oder Parameter enthalten");
        }
        if (!TOKEN_PATTERN.matcher(rawToken).matches()) {
            throw new IllegalStateException("BOT_HUB_TOKEN hat ein ungültiges Format");
        }
        return new HubLink(rawUrl.replaceAll("/+$", ""), rawToken);
    }

    public boolean isConnected() {
        return !baseUrl.isEmpty() && !token.isEmpty();
    }

    public void registerPanel() {
        request(
                "POST",
                "/panel",
                """
                {"panel":{"title":"Java Echo","icon":"☕","description":"Java-Bot-Status","settings":[],"commands":[]}}
                """);
    }

    public void publish(String status, long uptimeSeconds) {
        request(
                "POST",
                "/state",
                "{\"state\":{\"status\":\"" + json(status) + "\",\"uptime\":\""
                        + uptimeSeconds + " s\"}}");
    }

    public void notify(String message, String kind) {
        request(
                "POST",
                "/notify",
                "{\"message\":\"" + json(message) + "\",\"kind\":\"" + json(kind) + "\"}");
    }

    // ---------------------------------------------------------------
    // Bot-Speicher: ein Bereich pro Bot, nur für den laufenden Prozess.
    //
    // Die Werte werden als JSON übergeben und auch als JSON zurückgegeben –
    // diese Datei bleibt ohne weitere Abhängigkeit und übergibt dem Bot seinen
    // eigenen JSON-Weg. Welcher Bot schreibt, entscheidet das Token.
    // ---------------------------------------------------------------

    /** Legt einen Wert an oder überschreibt ihn. `value` muss gültiges JSON sein. */
    public boolean dbSet(String collection, String key, String value) {
        return request("PUT", dbPath(collection, key), "{\"value\":" + value + "}") != null;
    }

    /** Liest einen Wert als JSON-Text, oder null, wenn es ihn nicht gibt. */
    public String dbGet(String collection, String key) {
        String body = request("GET", dbPath(collection, key), null, true);
        return body == null ? null : jsonValue(body);
    }

    /** Listet eine Sammlung: {"entries":[…],"total":…,"limit":…,"offset":…} */
    public String dbList(String collection, String prefix, Integer limit, Integer offset) {
        StringBuilder path = new StringBuilder("/db/").append(segment(collection, "Sammlungsname"));
        StringBuilder parameter = new StringBuilder();
        if (prefix != null && !prefix.isEmpty()) {
            parameter.append("prefix=").append(encode(prefix));
        }
        if (limit != null) {
            parameter.append(parameter.isEmpty() ? "?" : "&").append("limit=").append(limit);
        }
        if (offset != null) {
            parameter.append(parameter.isEmpty() ? "?" : "&").append("offset=").append(offset);
        }
        if (!parameter.isEmpty()) {
            path.append('?').append(parameter);
        }
        return request("GET", path.toString(), null);
    }

    /** Löscht einen Eintrag. */
    public boolean dbRemove(String collection, String key) {
        String body = request("DELETE", dbPath(collection, key), null);
        return body != null && body.contains("\"removed\":true");
    }

    /**
     * Ein Pfadsegment für den Bot-Speicher, kodiert.
     *
     * Der Hub prüft Namen gegen ein Muster und setzt sie als Parameter in die
     * SQL-Abfrage; hier werden sie nur kodiert, damit ein Doppelpunkt im
     * Schlüssel den Weg nicht verändert.
     */
    private static String segment(String value, String label) {
        String text = value == null ? "" : value.trim();
        if (text.isEmpty()) {
            throw new IllegalArgumentException(label + " darf nicht leer sein");
        }
        return encode(text);
    }

    private static String encode(String value) {
        // URLEncoder ist für Formulare gedacht: Leerzeichen würden zu "+".
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String dbPath(String collection, String key) {
        return "/db/" + segment(collection, "Sammlungsname") + "/" + segment(key, "Schlüssel");
    }

    /**
     * Schneidet aus `{"entry":{…,"value":<json>,…}}` den Teil hinter "value"
     * heraus. Ein eigener JSON-Weg wäre hier zu viel für eine Fassade; der Bot
     * liest den Text mit seinem eigenen Parser.
     */
    private static String jsonValue(String body) {
        int start = body.indexOf("\"entry\"");
        if (start < 0) {
            return null;
        }
        int at = body.indexOf("\"value\":", start);
        if (at < 0) {
            return null;
        }
        int from = at + "\"value\":".length();
        while (from < body.length() && Character.isWhitespace(body.charAt(from))) {
            from++;
        }
        if (from >= body.length()) {
            return null;
        }
        char open = body.charAt(from);
        if (open == '"') {
            return quoted(body, from);
        }
        if (open != '{' && open != '[') {
            int end = from;
            while (end < body.length() && ",}] \n\r\t".indexOf(body.charAt(end)) < 0) {
                end++;
            }
            return body.substring(from, end);
        }
        int depth = 0;
        boolean inText = false;
        boolean escaped = false;
        for (int i = from; i < body.length(); i++) {
            char c = body.charAt(i);
            if (inText) {
                if (escaped) {
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (c == '"') {
                    inText = false;
                }
                continue;
            }
            if (c == '"') {
                inText = true;
            } else if (c == '{' || c == '[') {
                depth++;
            } else if (c == '}' || c == ']') {
                depth--;
                if (depth == 0) {
                    return body.substring(from, i + 1);
                }
            }
        }
        return body.substring(from);
    }

    /** Eine JSON-Zeichenkette samt Anführungszeichen, ohne den Rest der Antwort. */
    private static String quoted(String body, int from) {
        boolean escaped = false;
        for (int i = from + 1; i < body.length(); i++) {
            char c = body.charAt(i);
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == '"') {
                return body.substring(from, i + 1);
            }
        }
        return body.substring(from);
    }

    /**
     * `missingAsNull` betrifft nur 404: für Abfragen, bei denen "nicht
     * vorhanden" eine normale Antwort ist. Der Hub antwortet darauf mit 404 und
     * ohne Meldung – für den Bot ist das kein Fehler.
     */
    private String request(String method, String path, String body, boolean missingAsNull) {
        if (!isConnected()) {
            return null;
        }
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/hub" + path))
                    .timeout(TIMEOUT)
                    .header("Authorization", "Bearer " + token)
                    .header("Accept", "application/json");
            if ("POST".equals(method) || "PUT".equals(method)) {
                builder.header("Content-Type", "application/json")
                        .method(
                                method,
                                HttpRequest.BodyPublishers.ofString(body == null ? "{}" : body));
            } else if ("DELETE".equals(method)) {
                builder.DELETE();
            } else {
                builder.GET();
            }
            HttpResponse<String> response = client.send(
                    builder.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 404 && missingAsNull) {
                return null;
            }
            if (response.statusCode() / 100 != 2) {
                throw new IOException("HTTP " + response.statusCode());
            }
            return response.body();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            System.err.println("Bot-Hub-Anfrage unterbrochen: " + error.getMessage());
        } catch (IOException | IllegalArgumentException error) {
            System.err.println("Bot-Hub-Anfrage fehlgeschlagen: " + error.getMessage());
        }
        return null;
    }

    private String request(String method, String path, String body) {
        return request(method, path, body, false);
    }

    /**
     * Wandelt eine Zeichenkette in den Inhalt eines JSON-Strings – ohne die
     * Anführungszeichen, die die Aufruferin schon gesetzt hat.
     *
     * Vollständig escapen ist hier wichtiger, als es aussieht: JSON verlangt
     * jedes Steuerzeichen unter U+0020 zu maskieren, auch Tab und Backspace. Ein
     * unvollständiges Escaping wirft keine Ausnahme, es schickt ein Paket, das
     * die Gegenseite nicht lesen kann – der Hub meldet dann "ungültiges JSON"
     * und der Bot meldet sich gar nicht mehr.
     */
    private static String json(String value) {
        String text = String.valueOf(value);
        StringBuilder out = new StringBuilder(text.length() + 8);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                case '\b':
                    out.append("\\b");
                    break;
                case '\f':
                    out.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                    break;
            }
        }
        return out.toString();
    }
}
