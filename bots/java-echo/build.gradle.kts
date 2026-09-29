plugins {
    java
    id("com.github.johnrengelman.shadow") version "8.1.1"
}

group = "dev.bothub"
version = "1.0.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("net.dv8tion:JDA:5.0.0-beta.13") {
        exclude(module = "opus-java")
    }
}

tasks.withType<JavaCompile> {
    options.release.set(17)
}

tasks.shadowJar {
    archiveFileName.set("bot.jar")
    mergeServiceFiles()
}

tasks.build {
    dependsOn(tasks.shadowJar)
}
