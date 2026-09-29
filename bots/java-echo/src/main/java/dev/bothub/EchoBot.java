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
        String token = System.getenv("DISCORD_BOT_TOKEN");
        if (token == null || token.isBlank()) {
            System.out.println("WARNUNG: DISCORD_BOT_TOKEN fehlt – der Bot startet nicht.");
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
