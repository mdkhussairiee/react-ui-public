import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { smwebsdk } from '@soulmachines/smwebsdk';
import { resetWarningCache } from 'prop-types';
import proxyVideo from '../../proxyVideo';

const ORCHESTRATION_MODE = false;
const TOKEN_ISSUER = 'https://localhost:5000/auth/authorize';

const initialState = {
  connected: false,
  loading: false,
  error: null,
  isMuted: false,
  videoHeight: window.innerHeight,
  videoWidth: window.innerWidth,
  transcript: [],
  speechState: 'idle',
  // NLP gives us results as it processes final user utterance
  intermediateUserUtterance: '',
  userSpeaking: false,
  lastUserUtterance: '',
  lastPersonaUtterance: '',
  user: {
    activity: {
      isAttentive: 0,
      isTalking: 0,
    },
    emotion: {
      confusion: 0,
      negativity: 0,
      positivity: 0,
      confidence: 0,
    },
    conversation: {
      turn: '',
      context: {
        FacePresent: 0,
        PersonaTurn_IsAttentive: 0,
        PersonaTurn_IsTalking: null,
        Persona_Turn_Confusion: null,
        Persona_Turn_Negativity: null,
        Persona_Turn_Positivity: null,
        UserTurn_IsAttentive: 0,
        UserTurn_IsTalking: null,
        User_Turn_Confusion: null,
        User_Turn_Negativity: null,
        User_Turn_Positivity: null,
      },
    },
  },
  callQuality: {
    audio: {
      bitrate: null,
      packetsLost: null,
      roundTripTime: null,
    },
    video: {
      bitrate: null,
      packetsLost: null,
      roundTripTime: null,
    },
  },
};

// we need to define an object for actions here, since we need the types to be avaliable for
// async calls later, e.g. handling messages from persona
let actions;
let persona = null;
let scene = null;

// stuff like emotional data has way more decimal places than is useful, round values
const roundObject = (o, multiplier = 10) => {
  const output = {};
  Object.keys(o).forEach((k) => {
    output[k] = Math.floor(o[k] * multiplier) / multiplier;
  });
  return output;
};

// tells persona to stop listening to mic input
export const mute = createAsyncThunk('sm/mute', async (args, thunk) => {
  const { isMuted } = thunk.getState().sm;
  if (scene) {
    const muteState = !isMuted;
    console.log(muteState);
    const command = `${muteState ? 'stop' : 'start'}Recognize`;
    scene.sendRequest(command, {});
    thunk.dispatch(actions.setMute({ isMuted: muteState }));
  } else { console.warn('muting not possible, no active scene!'); }
});

// handles both manual disconnect or automatic timeout due to innactivity
export const disconnect = createAsyncThunk('sm/disconnect', async (args, thunk) => {
  thunk.dispatch(actions.disconnect());
  setTimeout(() => {
    if (scene) scene.disconnect();
    scene = null;
    persona = null;
  }, 500);
});

export const createScene = createAsyncThunk('sm/createScene', async (audioOnly = false, thunk) => {
  /* CREATE SCENE */
  // request permissions from user
  const { microphone, microphoneAndCamera } = smwebsdk.userMedia;
  const requestedUserMedia = audioOnly ? microphone : microphoneAndCamera;
  // create instance of Scene w/ granted permissions
  scene = new smwebsdk.Scene(
    proxyVideo,
    false,
    requestedUserMedia,
    microphone,
  );
  /* BIND HANDLERS */
  scene.onDisconnected = () => disconnect();
  scene.onMessage = (message) => {
    switch (message.name) {
      // handles output from TTS (what user said)
      case ('recognizeResults'): {
        const output = message.body.results[0];
        const { transcript: text } = output.alternatives[0];
        // we get multiple recognizeResults messages, so only add the final one to transcript
        // but keep track of intermediate one to show the user what they're saying
        if (output.final === false) {
          return thunk.dispatch(actions.setIntermediateUserUtterance({
            text,
          }));
        }
        return thunk.dispatch(actions.addConversationResult({
          source: 'user',
          text,
        }));
      }

      // handles output from NLP (what DP is saying)
      case ('conversationResult'): {
        const { text } = message.body.output;
        const action = actions.addConversationResult({
          source: 'persona',
          text,
        });
        return thunk.dispatch(action);
      }

      // personaResponse doesn't contain much data that isn't in recognizeResults or
      // conversationResult, so i've chosen to leave this unimplemented for now
      case ('personaResponse'): {
        // console.warn('personaResponse handler not yet implemented', message.body);
        break;
      }

      // state messages contain a lot of things, including user emotions,
      // call stats, and persona state
      case ('state'): {
        const { body } = message;
        if ('persona' in body) {
          const personaState = body.persona[1];

          // handle changes to persona speech state ie idle, animating, speaking
          if ('speechState' in personaState) {
            const { speechState } = personaState;
            const action = actions.setSpeechState({ speechState });
            thunk.dispatch(action);
          }

          if ('users' in personaState) {
            const userState = personaState.users[0];

            // we get emotional data from webcam feed
            if ('emotion' in userState) {
              const { emotion } = userState;
              const roundedEmotion = roundObject(emotion);
              const action = actions.setEmotionState({ emotion: roundedEmotion });
              thunk.dispatch(action);
            }

            if ('activity' in userState) {
              const { activity } = userState;
              const roundedActivity = roundObject(activity, 1000);
              const action = actions.setEmotionState({ activity: roundedActivity });
              thunk.dispatch(action);
            }

            if ('conversation' in userState) {
              const { conversation } = userState;
              const { context } = conversation;
              const roundedContext = roundObject(context);
              const action = actions.setConversationState({
                conversation: {
                  ...conversation,
                  context: roundedContext,
                },
              });
              thunk.dispatch(action);
            }
          }
        } else if ('statistics' in body) {
          const { callQuality } = body.statistics;
          thunk.dispatch(actions.setCallQuality({ callQuality }));
        }
        break;
      }

      // activation events i think are some kind of emotional metadata
      case ('activation'): {
        // console.warn('activation handler not yet implemented', message);
        break;
      }

      default: {
        console.warn(`unknown message type: ${message.name}`, message);
      }
    }
  };

  // copied from old template, not sure if there are other possible values for this?
  const PERSONA_ID = '1';
  // create instance of Persona class w/ scene instance
  persona = new smwebsdk.Persona(scene, PERSONA_ID);

  /* CONNECT TO PERSONA */
  try {
    // get signed JWT from token server so we can connect to Persona serverj
    const res = await fetch(TOKEN_ISSUER, { method: 'POST' });
    const { url, jwt } = await res.json();

    // connect to Persona server
    const retryOptions = {
      maxRetries: 20,
      delayMs: 500,
    };
    await scene.connect(url, '', jwt, retryOptions);

    // we can't disable logging until after the connection is established
    // logging is pretty crowded, not reccommended to enable
    // unless you need to debug emotional data from webcam
    scene.session().setLogging(false);

    // set video dimensions
    const { videoWidth, videoHeight } = thunk.getState().sm;
    scene.sendVideoBounds(videoWidth, videoHeight);

    // fulfill promise, reducer sets state to indiate loading and connection are complete
    return thunk.fulfillWithValue();
  } catch (err) {
    // TODO: try to handle blocked permissions a la https://github.com/soulmachines/cs-gem-poc-ui/blob/9c4ce7f475e0ec1b34a80d8271dd5bf81134cfb9/src/contexts/SoulMachines.js#L436
    return thunk.rejectWithValue(err);
  }
});

// send plain text to the persona.
// usually used for typed input or UI elems that trigger a certain phrase
export const sendTextMessage = createAsyncThunk('sm/sendTextMessage', async ({ text }, thunk) => {
  if (scene && persona) {
    if (ORCHESTRATION_MODE) scene.sendUserText(text);
    else persona.conversationSend(text);
    thunk.dispatch(actions.addConversationResult({
      source: 'user',
      text,
    }));
  } else thunk.rejectWithValue('not connected to persona!');
});

const smSlice = createSlice({
  name: 'sm',
  initialState,
  reducers: {
    stopSpeaking: (state) => {
      if (persona) persona.stopSpeaking();
      return { ...state };
    },
    setMute: (state, { payload }) => ({
      ...state,
      isMuted: payload.isMuted,
    }),
    setIntermediateUserUtterance: (state, { payload }) => ({
      ...state,
      intermediateUserUtterance: payload.text,
      userSpeaking: true,
    }),
    addConversationResult: (state, { payload }) => ({
      ...state,
      transcript: [...state.transcript, {
        source: payload.source,
        text: payload.text,
        timestamp: new Date().toISOString(),
      }],
      [payload.source === 'user' ? 'lastUserUtterance' : 'lastPersonaUtterance']: payload.text,
      intermediateUserUtterance: '',
      userSpeaking: false,
    }),
    setSpeechState: (state, { payload }) => ({
      ...state,
      speechState: payload.speechState,
    }),
    setEmotionState: (state, { payload }) => ({
      ...state,
      user: {
        ...state.user,
        emotion: payload.emotion,
      },
    }),
    setConversationState: (state, { payload }) => ({
      ...state,
      user: {
        ...state.user,
        conversation: payload.conversation,
      },
    }),
    setActivityState: (state, { payload }) => ({
      ...state,
      user: {
        ...state.user,
        activity: payload.activity,
      },
    }),
    setCallQuality: (state, { payload }) => ({
      ...state,
      callQuality: payload.callQuality,
    }),
    setVideoDimensions: (state, { payload }) => {
      const { videoWidth, videoHeight } = payload;
      // update video dimensions in persona
      scene.sendVideoBounds(videoWidth, videoHeight);
      return { ...state, videoWidth, videoHeight };
    },
    disconnect: (state) => ({
      ...state,
      connected: false,
      error: null,
    }),
  },
  extraReducers: {
    [createScene.pending]: (state) => ({
      ...state,
      loading: true,
    }),
    [createScene.fulfilled]: (state) => ({
      ...state,
      loading: false,
      connected: true,
    }),
    [createScene.rejected]: (state, { error }) => ({
      ...state,
      loading: false,
      connected: false,
      error,
    }),
  },
});

// hoist actions to top of file so thunks can access
actions = smSlice.actions;

export const { setVideoDimensions, stopSpeaking } = smSlice.actions;

export default smSlice.reducer;