import {useNavigate, useParams} from "react-router-dom";
import {useContext, useEffect, useState} from "react";
import subscriptionManager from "../app/SubscriptionManager";
import {disallowedTopic, expandSecureUrl, topicUrl} from "../app/utils";
import notifier from "../app/Notifier";
import routes from "./routes";
import connectionManager from "../app/ConnectionManager";
import poller from "../app/Poller";
import pruner from "../app/Pruner";
import session from "../app/Session";
import {UnauthorizedError} from "../app/AccountApi";
import accountApi from "../app/AccountApi";
import {AccountContext} from "./App";

/**
 * Wire connectionManager and subscriptionManager so that subscriptions are updated when the connection
 * state changes. Conversely, when the subscription changes, the connection is refreshed (which may lead
 * to the connection being re-established).
 */
export const useConnectionListeners = (subscriptions, users) => {
    const navigate = useNavigate();

    useEffect(() => {
            const handleMessage = async (subscriptionId, message) => {
                const subscription = await subscriptionManager.get(subscriptionId);
                if (subscription.internal) {
                    await handleInternalMessage(message);
                } else {
                    await handleNotification(subscriptionId, message);
                }
            };

            const handleInternalMessage = async (message) => {
                console.log(`[ConnectionListener] Received message on sync topic`, message.message);
                try {
                    const data = JSON.parse(message.message);
                    if (data.event === "sync") {
                        if (data.source !== accountApi.identity) {
                            console.log(`[ConnectionListener] Triggering account sync`);
                            await accountApi.sync();
                        } else {
                            console.log(`[ConnectionListener] I triggered the account sync, ignoring message`);
                        }
                    } else {
                        console.log(`[ConnectionListener] Unknown message type. Doing nothing.`);
                    }
                } catch (e) {
                    console.log(`[ConnectionListener] Error parsing sync topic message`, e);
                }
            };

            const handleNotification = async (subscriptionId, notification) => {
                const added = await subscriptionManager.addNotification(subscriptionId, notification);
                if (added) {
                    const defaultClickAction = (subscription) => navigate(routes.forSubscription(subscription));
                    await notifier.notify(subscriptionId, notification, defaultClickAction)
                }
            };
            connectionManager.registerStateListener(subscriptionManager.updateState);
            connectionManager.registerMessageListener(handleMessage);
            return () => {
                connectionManager.resetStateListener();
                connectionManager.resetMessageListener();
            }
        },
        // We have to disable dep checking for "navigate". This is fine, it never changes.
        // eslint-disable-next-line
        []
    );

    useEffect(() => {
        connectionManager.refresh(subscriptions, users); // Dangle
    }, [subscriptions, users]);
};

/**
 * Automatically adds a subscription if we navigate to a page that has not been subscribed to.
 * This will only be run once after the initial page load.
 */
export const useAutoSubscribe = (subscriptions, selected) => {
    const [hasRun, setHasRun] = useState(false);
    const params = useParams();

    useEffect(() => {
        const loaded = subscriptions !== null && subscriptions !== undefined;
        if (!loaded || hasRun) {
            return;
        }
        setHasRun(true);
        const eligible = params.topic && !selected && !disallowedTopic(params.topic);
        if (eligible) {
            const baseUrl = (params.baseUrl) ? expandSecureUrl(params.baseUrl) : config.base_url;
            console.log(`[App] Auto-subscribing to ${topicUrl(baseUrl, params.topic)}`);
            (async () => {
                const subscription = await subscriptionManager.add(baseUrl, params.topic);
                if (session.exists()) {
                    try {
                        const remoteSubscription = await accountApi.addSubscription({
                            base_url: baseUrl,
                            topic: params.topic
                        });
                        await subscriptionManager.setRemoteId(subscription.id, remoteSubscription.id);
                    } catch (e) {
                        console.log(`[App] Auto-subscribing failed`, e);
                        if ((e instanceof UnauthorizedError)) {
                            session.resetAndRedirect(routes.login);
                        }
                    }
                }
                poller.pollInBackground(subscription); // Dangle!
            })();
        }
    }, [params, subscriptions, selected, hasRun]);
};

/**
 * Start the poller and the pruner. This is done in a side effect as opposed to just in Pruner.js
 * and Poller.js, because side effect imports are not a thing in JS, and "Optimize imports" cleans
 * up "unused" imports. See https://github.com/binwiederhier/ntfy/issues/186.
 */
export const useBackgroundProcesses = () => {
    useEffect(() => {
        poller.startWorker();
        pruner.startWorker();
        accountApi.startWorker();
    }, []);
}

export const useAccountListener = (setAccount) => {
    useEffect(() => {
        accountApi.registerListener(setAccount);
        accountApi.sync(); // Dangle
        return () => {
            accountApi.resetListener();
        }
    }, []);
}
