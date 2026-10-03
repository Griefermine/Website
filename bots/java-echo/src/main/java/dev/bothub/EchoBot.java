package dev.bothub;

import net.dv8tion.jda.api.JDA;
import net.dv8tion.jda.api.JDABuilder;
import net.dv8tion.jda.api.entities.MessageChannel;
import net.dv8tion.jda.api.events.message.MessageReceivedEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;
import net.dv8tion.jda.api.requests.GatewayIntent;
import net.dv8tion.jda.api.utils.ChunkingFilter;
import net.dv8tion.jda.api.utils.MemberCachePolicy;
import net.dv8tion.jda.api.utils.cache.CacheFlag;

public class EchoBot extends ListenerAdapter {

    public static void main(String[] args) {
        HubLink hub = HubLink.fromEnvironment();
        long started = System.currentTimeMillis();
        if (hub.isConnected()) {
            System.out.println("Bot-Hub erkannt");
            hub.registerPanel();
            hub.publish("starting", 0);
        }

        String token = System.getenv("DISCORD_BOT_TOKEN");
        if (token == null || token.isBlank()) {
            System.out.println("WARNUNG: DISCORD_BOT_TOKEN fehlt – der Bot startet nicht.");
            hub.publish("stopped", elapsedSeconds(started));
            return;
        }
        System.out.println("java-echo startet (JDA)");

        JDA jda = JDABuilder.createDefault(token)
                .enableIntents(GatewayIntent.GUILD_MESSAGES, GatewayIntent.MESSAGE_CONTENT)
                .enableCache(CacheFlag.MEMBER)
                .setMemberCachePolicy(MemberCachePolicy.ALL)
                .setChunkingFilter(ChunkingFilter.NONE)
                .addEventListeners(new EchoBot())
                .build();

        jda.awaitReady();
        System.out.println("eingeloggt als " + jda.getSelfUser().getName());
        hub.publish("online", elapsedSeconds(started));
        hub.notify(jda.getSelfUser().getName() + " ist bereit.", "success");
    }

    private static long elapsedSeconds(long started) {
        return Math.max(0, (System.currentTimeMillis() - started) / 1000);
    }

    @Override
    public void onMessageReceived(MessageReceivedEvent event) {
        if (event.getAuthor().isBot() || !event.getMessage().getContentRaw().equals("!ping")) {
            return;
        }
        MessageChannel channel = event.getChannel();
        channel.sendMessage("🏓 Pong! von Java").queue();
        System.out.println("auf !ping geantwortet");
    }
}
